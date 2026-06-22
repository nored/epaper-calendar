// ESP32-S3-ePaper-13.3E6 — battery calendar client.
//
// Once per day: wake from deep sleep -> read battery -> WiFi -> download the
// pre-rendered 960 KB 6-color framebuffer from the server -> push to panel ->
// deep sleep again for the duration the server tells us (X-Sleep-Seconds).
//
// All layout/data/rendering lives on the server. This firmware never draws.

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <esp_sleep.h>
#include <esp_wifi.h>

extern "C" {
  #include "DEV_Config.h"
  #include "EPD_13in3e.h"
}
#include "config.h"

#define FRAME_BYTES (600UL * 1600UL)   // 960000 — must match the panel framebuffer
#define BATT_ADC_PIN 8                 // ADC1_CH7, divider x3 (per Waveshare ADC example)
#define WIFI_TIMEOUT_MS 20000
#define FAIL_RETRY_SECONDS 3600        // if anything fails, retry in 1 h

// Persisted across deep sleep for fast WiFi reconnect.
RTC_DATA_ATTR static uint8_t  rtcBssid[6];
RTC_DATA_ATTR static int32_t  rtcChannel = 0;
RTC_DATA_ATTR static bool     rtcHaveAp  = false;
RTC_DATA_ATTR static uint32_t rtcBootCount = 0;

static float readBatteryVolts() {
  analogSetPinAttenuation(BATT_ADC_PIN, ADC_11db);
  uint32_t mv = 0;
  for (int i = 0; i < 8; i++) mv += analogReadMilliVolts(BATT_ADC_PIN);
  mv /= 8;
  return (mv * 3.0f) / 1000.0f;   // x3 hardware divider
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
  WiFi.disconnect(true);
  esp_wifi_stop();
  esp_sleep_enable_timer_wakeup(seconds * 1000000ULL);
  esp_deep_sleep_start();
}

static bool connectWiFi() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  if (rtcHaveAp) WiFi.begin(WIFI_SSID, WIFI_PASS, rtcChannel, rtcBssid); // fast path
  else           WiFi.begin(WIFI_SSID, WIFI_PASS);

  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TIMEOUT_MS) delay(100);

  if (WiFi.status() != WL_CONNECTED && rtcHaveAp) {
    // cached AP info stale — full scan retry once
    rtcHaveAp = false;
    WiFi.disconnect(true); delay(100);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
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

// Download the framebuffer into `buf`. Returns sleep seconds (-1 on failure).
static long fetchFrame(uint8_t* buf, float volts) {
  HTTPClient http;
  char url[256];
  snprintf(url, sizeof(url), "%s?batt=%.2f&reason=%s&boot=%lu",
           SERVER_FRAME_URL, volts, wakeReason(), (unsigned long)rtcBootCount);
  Serial.printf("GET %s\n", url);

  if (!http.begin(url)) return -1;
  const char* hdrs[] = {"X-Sleep-Seconds"};
  http.collectHeaders(hdrs, 1);
  http.setTimeout(20000);

  int code = http.GET();
  if (code != HTTP_OK) { Serial.printf("HTTP %d\n", code); http.end(); return -1; }

  int len = http.getSize();
  if (len > 0 && (uint32_t)len != FRAME_BYTES) {
    Serial.printf("Unexpected length %d (want %lu)\n", len, FRAME_BYTES);
  }

  WiFiClient* stream = http.getStreamPtr();
  uint32_t got = 0;
  uint32_t t0 = millis();
  while (got < FRAME_BYTES && (http.connected() || stream->available())) {
    size_t avail = stream->available();
    if (avail) {
      int r = stream->readBytes(buf + got, min(avail, (size_t)(FRAME_BYTES - got)));
      got += r;
    } else {
      if (millis() - t0 > 20000) break;
      delay(2);
    }
  }
  long sleepSecs = http.header("X-Sleep-Seconds").toInt();
  http.end();

  Serial.printf("Received %lu/%lu bytes in %lu ms, sleep=%ld\n",
                (unsigned long)got, FRAME_BYTES, millis() - t0, sleepSecs);
  if (got != FRAME_BYTES) return -1;
  if (sleepSecs < 60) sleepSecs = 86400; // safety default: 1 day
  return sleepSecs;
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
  Serial.begin(115200);
  delay(50);
  Serial.printf("\n=== boot #%lu, wake=%s ===\n", (unsigned long)rtcBootCount, wakeReason());

  float volts = readBatteryVolts();
  Serial.printf("Battery: %.2f V\n", volts);

  uint8_t* frame = (uint8_t*)heap_caps_malloc(FRAME_BYTES, MALLOC_CAP_SPIRAM);
  if (!frame) { Serial.println("PSRAM alloc failed!"); deepSleep(FAIL_RETRY_SECONDS); }

  if (!connectWiFi()) { Serial.println("WiFi failed"); deepSleep(FAIL_RETRY_SECONDS); }

  long sleepSecs = fetchFrame(frame, volts);
  if (sleepSecs < 0) { Serial.println("Fetch failed"); deepSleep(FAIL_RETRY_SECONDS); }

  // WiFi off before the slow panel refresh to save power.
  WiFi.disconnect(true);
  esp_wifi_stop();

  showFrame(frame);
  heap_caps_free(frame);

  deepSleep((uint64_t)sleepSecs);
}

void loop() { /* never reached; everything happens in setup() then deep sleep */ }
