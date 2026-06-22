// ESP32-S3-ePaper-13.3E6 — battery calendar client.
//
// Once per day: wake from deep sleep -> read battery -> WiFi -> download the
// pre-rendered 960 KB 6-color framebuffer from the server -> (optionally OTA if
// the server advertises a newer build, same wake) -> push to panel -> deep sleep
// for the duration the server tells us (X-Sleep-Seconds).
//
// Strictly ONE radio-on wake per day (battery). OTA piggybacks the daily fetch:
// no extra wakeups, and the new image is staged (boot partition set) to run on
// the NEXT daily wake rather than rebooting now.
//
// Config (WiFi + server URL) lives in NVS, written over USB-serial by the
// web-flasher. config.h is an optional compile-time fallback for power users.
// All layout/data/rendering lives on the server. This firmware never draws.

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>
#include <esp_sleep.h>
#include <esp_wifi.h>
#include <time.h>
#include <sys/time.h>

extern "C" {
  #include "DEV_Config.h"
  #include "EPD_13in3e.h"
}
#if __has_include("config.h")
  #include "config.h"   // optional: WIFI_SSID / WIFI_PASS / SERVER_BASE_URL defaults
#endif

// Bumped on every firmware change; the server advertises the latest via the
// X-FW-Version response header and the device OTA-updates when server > this.
#define FW_VERSION 1

#define FRAME_BYTES (600UL * 1600UL)   // 960000 — must match the panel framebuffer
#define BATT_ADC_PIN 8                 // ADC1_CH7, calibrated mV x3 (per Waveshare ADC example)
#define WIFI_TIMEOUT_MS 20000
#define FAIL_RETRY_SECONDS 3600        // if anything fails, retry in 1 h
#define PROV_BAUD 115200

// ---- exact-midnight wake (NTP-disciplined deep-sleep timer) ----
#define WAKE_TARGET_HOUR 0             // refresh at local midnight
#define TZ_BERLIN "CET-1CEST,M3.5.0,M10.5.0/3"  // DST-aware; mktime/localtime use it
// Approx wall-seconds from wake to the panel-refresh COMPLETING (WiFi + NTP +
// fetch + ~30 s panel refresh). We aim the disciplined wake this far BEFORE
// midnight so the new day lands ON screen at 00:00. TUNE after timing one cycle.
#define WAKE_LEAD_S 60
#define LOW_BATT_VOLTS 3.5f           // below this, honor the server's backoff instead

// Persisted across deep sleep for fast WiFi reconnect.
RTC_DATA_ATTR static uint8_t  rtcBssid[6];
RTC_DATA_ATTR static int32_t  rtcChannel = 0;
RTC_DATA_ATTR static bool     rtcHaveAp  = false;
RTC_DATA_ATTR static uint32_t rtcBootCount = 0;

// Clock-discipline state persisted across deep sleep.
RTC_DATA_ATTR static int64_t  rtcSleepStartUs = 0; // true epoch µs when last deep sleep began
RTC_DATA_ATTR static int64_t  rtcReqSleepUs   = 0; // µs we asked the timer to sleep last cycle
RTC_DATA_ATTR static double   rtcClockK       = 1.0; // EMA: real seconds per requested second
RTC_DATA_ATTR static bool     rtcHaveK        = false;

// Runtime config, loaded from NVS (or config.h fallback).
static String cfgSsid, cfgPass, cfgBaseUrl;

static float readBatteryVolts() {
  analogSetPinAttenuation(BATT_ADC_PIN, ADC_11db);
  uint32_t mv = 0;
  for (int i = 0; i < 8; i++) mv += analogReadMilliVolts(BATT_ADC_PIN);
  mv /= 8;
  return (mv * 3.0f) / 1000.0f;   // x3 hardware divider, calibrated mV
}

static const char* wakeReason() {
  switch (esp_sleep_get_wakeup_cause()) {
    case ESP_SLEEP_WAKEUP_TIMER: return "timer";
    case ESP_SLEEP_WAKEUP_EXT0:
    case ESP_SLEEP_WAKEUP_EXT1:  return "button";
    default:                     return "poweron";
  }
}

static void deepSleep(uint64_t seconds) {
  Serial.printf("Deep sleep for %llu s\n", seconds);
  Serial.flush();
  rtcReqSleepUs = 0;   // non-disciplined sleep — don't learn drift from it next wake
  WiFi.disconnect(true);
  esp_wifi_stop();
  esp_sleep_enable_timer_wakeup(seconds * 1000000ULL);
  esp_deep_sleep_start();
}

// ---- config (NVS) ----------------------------------------------------------
// Stored under namespace "epaper": ssid, pass, url (base, e.g. http://nas:8090).
static bool loadConfig() {
  Preferences p;
  p.begin("epaper", true);
  cfgSsid    = p.getString("ssid", "");
  cfgPass    = p.getString("pass", "");
  cfgBaseUrl = p.getString("url",  "");
  p.end();

#if defined(WIFI_SSID) && defined(SERVER_BASE_URL)
  if (cfgSsid.isEmpty())    cfgSsid    = WIFI_SSID;
  if (cfgPass.isEmpty())    cfgPass    = WIFI_PASS;
  if (cfgBaseUrl.isEmpty()) cfgBaseUrl = SERVER_BASE_URL;
#endif

  cfgBaseUrl.trim();
  while (cfgBaseUrl.endsWith("/")) cfgBaseUrl.remove(cfgBaseUrl.length() - 1);
  return !cfgSsid.isEmpty() && !cfgBaseUrl.isEmpty();
}

static void saveConfig(const String& ssid, const String& pass, const String& url) {
  Preferences p;
  p.begin("epaper", false);
  p.putString("ssid", ssid);
  p.putString("pass", pass);
  p.putString("url",  url);
  p.end();
}

// Provisioning line written by the web-flasher over USB-serial:
//   CFG\t<ssid>\t<pass>\t<base-url>\n   ->  device replies "CFG_OK\n"
// Returns true if a config line was consumed within `windowMs`.
static bool readProvisioningLine(uint32_t windowMs) {
  uint32_t t0 = millis();
  String line;
  while (millis() - t0 < windowMs) {
    while (Serial.available()) {
      char ch = (char)Serial.read();
      if (ch == '\n' || ch == '\r') {
        if (line.startsWith("CFG\t")) {
          int a = line.indexOf('\t');
          int b = line.indexOf('\t', a + 1);
          int c = line.indexOf('\t', b + 1);
          if (a > 0 && b > a && c > b) {
            String ssid = line.substring(a + 1, b);
            String pass = line.substring(b + 1, c);
            String url  = line.substring(c + 1);
            url.trim();
            saveConfig(ssid, pass, url);
            Serial.println("CFG_OK");
            return true;
          }
          Serial.println("CFG_ERR");
        }
        line = "";
      } else if (line.length() < 400) {
        line += ch;
      }
    }
    delay(5);
  }
  return false;
}

static bool connectWiFi() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  if (rtcHaveAp) WiFi.begin(cfgSsid.c_str(), cfgPass.c_str(), rtcChannel, rtcBssid); // fast path
  else           WiFi.begin(cfgSsid.c_str(), cfgPass.c_str());

  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TIMEOUT_MS) delay(100);

  if (WiFi.status() != WL_CONNECTED && rtcHaveAp) {
    // cached AP info stale — full scan retry once
    rtcHaveAp = false;
    WiFi.disconnect(true); delay(100);
    WiFi.begin(cfgSsid.c_str(), cfgPass.c_str());
    t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TIMEOUT_MS) delay(100);
  }
  if (WiFi.status() != WL_CONNECTED) return false;

  // cache AP for next wake
  memcpy(rtcBssid, WiFi.BSSID(), 6);
  rtcChannel = WiFi.channel();
  rtcHaveAp = true;
  Serial.printf("WiFi OK %s, RSSI %d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  return true;
}

struct FetchResult { long sleepSecs; long fwVersion; };

// Download the framebuffer into `buf`. sleepSecs<0 on failure; fwVersion is the
// server's advertised latest build (-1 if absent).
static FetchResult fetchFrame(uint8_t* buf, float volts) {
  FetchResult r = { -1, -1 };
  HTTPClient http;
  char url[320];
  snprintf(url, sizeof(url), "%s/frame.bin?batt=%.2f&reason=%s&boot=%lu&fw=%d",
           cfgBaseUrl.c_str(), volts, wakeReason(), (unsigned long)rtcBootCount, FW_VERSION);
  Serial.printf("GET %s\n", url);

  if (!http.begin(url)) return r;
  const char* hdrs[] = {"X-Sleep-Seconds", "X-FW-Version"};
  http.collectHeaders(hdrs, 2);
  http.setTimeout(20000);

  int code = http.GET();
  if (code != HTTP_OK) { Serial.printf("HTTP %d\n", code); http.end(); return r; }

  int len = http.getSize();
  if (len > 0 && (uint32_t)len != FRAME_BYTES)
    Serial.printf("Unexpected length %d (want %lu)\n", len, FRAME_BYTES);

  WiFiClient* stream = http.getStreamPtr();
  uint32_t got = 0;
  uint32_t t0 = millis();
  while (got < FRAME_BYTES && (http.connected() || stream->available())) {
    size_t avail = stream->available();
    if (avail) {
      int rd = stream->readBytes(buf + got, min(avail, (size_t)(FRAME_BYTES - got)));
      got += rd;
    } else {
      if (millis() - t0 > 20000) break;
      delay(2);
    }
  }
  long sleepSecs = http.header("X-Sleep-Seconds").toInt();
  String fwHdr   = http.header("X-FW-Version");
  http.end();

  Serial.printf("Received %lu/%lu bytes in %lu ms, sleep=%ld, fw=%s\n",
                (unsigned long)got, FRAME_BYTES, millis() - t0, sleepSecs, fwHdr.c_str());
  if (got != FRAME_BYTES) return r;
  if (sleepSecs < 60) sleepSecs = 86400; // safety default: 1 day
  r.sleepSecs = sleepSecs;
  r.fwVersion = fwHdr.isEmpty() ? -1 : fwHdr.toInt();
  return r;
}

// Stage an OTA from <base>/firmware.bin. Stages the new image (sets boot
// partition) but does NOT reboot — it runs on the next daily wake, so no extra
// radio cycle today. Must be called while WiFi is up (before the panel refresh).
static void stageOTA() {
  HTTPClient http;
  String url = cfgBaseUrl + "/firmware.bin";
  Serial.printf("OTA GET %s\n", url.c_str());
  if (!http.begin(url)) { Serial.println("OTA begin failed"); return; }
  http.setTimeout(30000);
  int code = http.GET();
  if (code != HTTP_OK) { Serial.printf("OTA HTTP %d\n", code); http.end(); return; }

  int len = http.getSize();
  if (len <= 0) { Serial.println("OTA: unknown length"); http.end(); return; }
  if (!Update.begin(len)) { Serial.printf("OTA begin(%d) failed\n", len); http.end(); return; }

  size_t written = Update.writeStream(*http.getStreamPtr());
  http.end();
  if ((int)written != len) { Serial.printf("OTA wrote %u/%d\n", (unsigned)written, len); Update.abort(); return; }
  if (!Update.end(true))   { Serial.printf("OTA end failed: %s\n", Update.errorString()); return; }

  Serial.println("OTA staged — new firmware boots on next daily wake.");
}

// ---- NTP-disciplined exact-midnight wake -----------------------------------
static int64_t nowUs() {
  struct timeval tv; gettimeofday(&tv, NULL);
  return (int64_t)tv.tv_sec * 1000000LL + tv.tv_usec;
}

// Sync system time from NTP (TZ = Europe/Berlin). True once the clock is set.
static bool ntpSync() {
  configTzTime(TZ_BERLIN, "pool.ntp.org", "time.cloudflare.com", "time.google.com");
  struct tm ti;
  for (int i = 0; i < 100; i++) {            // up to ~10 s
    if (getLocalTime(&ti, 100) && ti.tm_year > 120) return true; // year > 2020
    delay(0);
  }
  return false;
}

// Fold this cycle's wake error into the clock-rate estimate K (real s per
// requested s). Call right after a successful NTP sync, before re-sleeping.
static void updateDiscipline() {
  if (rtcReqSleepUs <= 0) return;            // first ever sleep — nothing to learn yet
  int64_t realElapsed = nowUs() - rtcSleepStartUs;
  double k = (double)realElapsed / (double)rtcReqSleepUs;
  if (k < 0.5 || k > 2.0) return;            // implausible (NTP glitch / cold start) — ignore
  rtcClockK = rtcHaveK ? (0.6 * rtcClockK + 0.4 * k) : k; // EMA, seeded on first good sample
  rtcHaveK = true;
  Serial.printf("Clock K=%.6f (err this cycle %.1fs)\n",
                rtcClockK, (realElapsed - rtcReqSleepUs) / 1e6);
}

// Epoch µs of the next wake target = (local midnight − WAKE_LEAD_S), in the future.
static int64_t nextTargetUs() {
  time_t now = time(NULL);
  struct tm lt; localtime_r(&now, &lt);
  lt.tm_hour = WAKE_TARGET_HOUR; lt.tm_min = 0; lt.tm_sec = 0; lt.tm_isdst = -1;
  time_t midnight = mktime(&lt);
  if (midnight - WAKE_LEAD_S <= now) { lt.tm_mday += 1; lt.tm_isdst = -1; midnight = mktime(&lt); }
  return ((int64_t)midnight - WAKE_LEAD_S) * 1000000LL;
}

// Deep sleep until the next disciplined midnight target. Requests timer ticks
// pre-corrected by K so the RC-oscillator drift lands the wake on target.
static void disciplinedSleep() {
  int64_t now = nowUs();
  int64_t target = nextTargetUs();
  int64_t desiredReal = target - now;
  if (desiredReal < 60LL * 1000000LL) desiredReal += 24LL * 3600 * 1000000LL; // safety floor
  int64_t reqUs = (int64_t)((double)desiredReal / rtcClockK);
  rtcSleepStartUs = now;
  rtcReqSleepUs = reqUs;
  Serial.printf("Disciplined sleep: real %.1fs, request %.1fs (K=%.6f)\n",
                desiredReal / 1e6, reqUs / 1e6, rtcClockK);
  Serial.flush();
  WiFi.disconnect(true); esp_wifi_stop();
  esp_sleep_enable_timer_wakeup((uint64_t)reqUs);
  esp_deep_sleep_start();
}

static void showFrame(const uint8_t* buf) {
  DEV_Module_Init();
  EPD_13IN3E_Init();
  EPD_13IN3E_Display((UBYTE*)buf);
  EPD_13IN3E_Sleep();
  DEV_Module_Exit();
}

void setup() {
  rtcBootCount++;
  Serial.begin(PROV_BAUD);
  delay(50);
  Serial.printf("\n=== boot #%lu, wake=%s, fw=%d ===\n",
                (unsigned long)rtcBootCount, wakeReason(), FW_VERSION);

  bool configured = loadConfig();

  // Provisioning window: always give the flasher a brief chance to (re)write
  // config right after flash. If we have no config at all, listen indefinitely.
  if (!configured) {
    Serial.println("Unconfigured — waiting for CFG over serial...");
    while (!readProvisioningLine(60000)) { /* keep waiting; USB-powered during setup */ }
    configured = loadConfig();
  } else {
    readProvisioningLine(1500); // short window to allow re-provisioning, then proceed
    loadConfig();
  }

  float volts = readBatteryVolts();
  Serial.printf("Battery: %.2f V\n", volts);

  uint8_t* frame = (uint8_t*)heap_caps_malloc(FRAME_BYTES, MALLOC_CAP_SPIRAM);
  if (!frame) { Serial.println("PSRAM alloc failed!"); deepSleep(FAIL_RETRY_SECONDS); }

  if (!connectWiFi()) { Serial.println("WiFi failed"); deepSleep(FAIL_RETRY_SECONDS); }

  // Sync time and fold this wake's drift into the clock-rate estimate.
  bool ntpOk = ntpSync();
  if (ntpOk) updateDiscipline();
  else Serial.println("NTP failed — falling back to server sleep");

  FetchResult res = fetchFrame(frame, volts);
  if (res.sleepSecs < 0) { Serial.println("Fetch failed"); deepSleep(FAIL_RETRY_SECONDS); }

  // OTA piggybacks this same wake, while WiFi is still up.
  if (res.fwVersion > FW_VERSION) {
    Serial.printf("Newer firmware available (%ld > %d) — staging OTA\n", res.fwVersion, FW_VERSION);
    stageOTA();
  }

  // WiFi off before the slow panel refresh to save power.
  WiFi.disconnect(true);
  esp_wifi_stop();

  showFrame(frame);
  heap_caps_free(frame);

  // Low battery: honor the server's backoff (skip discipline). Otherwise, if we
  // have real time, sleep to the disciplined midnight target; else trust the
  // server's X-Sleep-Seconds.
  if (volts > 0.1f && volts < LOW_BATT_VOLTS) deepSleep((uint64_t)res.sleepSecs);
  else if (ntpOk)                             disciplinedSleep();
  else                                        deepSleep((uint64_t)res.sleepSecs);
}

void loop() { /* never reached; everything happens in setup() then deep sleep */ }
