/*****************************************************************************
* | File      	:   GUI_BMPfile.h
* | Author      :   Waveshare team
* | Function    :   Hardware underlying interface
* | Info        :
*                Used to shield the underlying layers of each master
*                and enhance portability
*----------------
* |	This version:   V2.3
* | Date        :   2022-07-27
* | Info        :   
* -----------------------------------------------------------------------------
* V2.3(2022-07-27):
* 1.Add GUI_ReadBmp_RGB_4Color()
* V2.2(2020-07-08):
* 1.Add GUI_ReadBmp_RGB_7Color()
* V2.1(2019-10-10):
* 1.Add GUI_ReadBmp_4Gray()
* V2.0(2018-11-12):
* 1.Change file name: GUI_BMP.h -> GUI_BMPfile.h
* 2.fix: GUI_ReadBmp()
*   Now Xstart and Xstart can control the position of the picture normally,
*   and support the display of images of any size. If it is larger than
*   the actual display range, it will not be displayed.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documnetation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to  whom the Software is
# furished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS OR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.
#
******************************************************************************/

#include "GUI_BMPfile.h"
#include "GUI_Paint.h"

#include <fcntl.h>
#include <unistd.h>
#include <stdint.h>
#include <stdlib.h>	//exit()
#include <string.h> //memset()
#include <math.h> //memset()
#include <stdio.h>

#include "esp_log.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "esp_heap_caps.h"

UBYTE GUI_ReadBmp_RGB_6Color(const char *path, UWORD Xstart, UWORD Ystart)
{
    BMPFILEHEADER bmpFileHeader;  //Define a bmp file header structure
    BMPINFOHEADER bmpInfoHeader;  //Define a bmp info header structure
        
    FILE *f = fopen(path, "rb");
    if (f == NULL)
    {
        printf("Cann't open the file!");
        return 0;
    }
    fseek(f, 0, SEEK_SET);
    uint32_t br = fread(&bmpFileHeader, 1 , sizeof(BMPFILEHEADER), f);
    if(br != sizeof(BMPFILEHEADER))
    {
        printf("Failed to read BMP file header");
        return 0;
    }
    br = fread(&bmpInfoHeader, 1,sizeof(BMPINFOHEADER), f);
    if(br != sizeof(BMPINFOHEADER))
    {
        printf("BmpInfoHeader error");
        return 0;
    }
    if((bmpInfoHeader.biWidth == 1200)&&(bmpInfoHeader.biHeight == 1600))
        Paint_SetRotate(0);
    else if((bmpInfoHeader.biWidth == 1600)&&(bmpInfoHeader.biHeight == 1200))
        Paint_SetRotate(90);
    printf("pixel = %ld x %ld\n", (long)bmpInfoHeader.biWidth, (long)bmpInfoHeader.biHeight);
    
    // Determine if it is a monochrome bitmap
    int readbyte = bmpInfoHeader.biBitCount;
    if(readbyte != 24)
    {
        printf("Bmp image is not 24 bitmap!");
    }
    // Read image data into the cache
    UWORD x, y;
    UBYTE Rdata[3];
    fseek(f, bmpFileHeader.bOffset, SEEK_SET);
    UBYTE color = 6;

    for(y = 0; y < bmpInfoHeader.biHeight; y++) {//Total display column
        for(x = 0; x < bmpInfoHeader.biWidth ; x++) {//Show a line in the line
            if(fread((char *)Rdata, 1, 1, f) != 1) 
            {
                break;
            }
            if(fread((char *)Rdata+1, 1, 1, f) != 1)
            {
                break;
            }
            if(fread((char *)Rdata+2, 1, 1, f) != 1)
            {
                break;
            }

            if(Rdata[0] == 0 && Rdata[1] == 0 && Rdata[2] == 0){
                // Image[x+(y* bmpInfoHeader.biWidth )] =  0;//Black
                color = 0;
            }else if(Rdata[0] == 255 && Rdata[1] == 255 && Rdata[2] == 255){
                // Image[x+(y* bmpInfoHeader.biWidth )] =  1;//White
                color = 1;
            }else if(Rdata[0] == 0 && Rdata[1] == 255 && Rdata[2] == 255){
                // Image[x+(y* bmpInfoHeader.biWidth )] =  2;//Yellow
                color = 2;
            }else if(Rdata[0] == 0 && Rdata[1] == 0 && Rdata[2] == 255){
                // Image[x+(y* bmpInfoHeader.biWidth )] =  3;//Red
                color = 3;
            }else if(Rdata[0] == 255 && Rdata[1] == 0 && Rdata[2] == 0){
                // Image[x+(y* bmpInfoHeader.biWidth )] =  5;//Blue
                color = 5;
            }else if(Rdata[0] == 0 && Rdata[1] == 255 && Rdata[2] == 0){
                // Image[x+(y* bmpInfoHeader.biWidth )] =  6;//Green
                color = 6;
            }else{
                color = 1;
            }
            Paint_SetPixel(Xstart+x, Ystart+bmpInfoHeader.biHeight-1-y, color);
            // Paint_SetPixel(Xstart + bmpInfoHeader.biWidth-1-x, Ystart + y, color);
        }
        // When reading a large amount of data, increase the delay to facilitate the CPU in processing the content of other threads
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    fclose(f);
    return 0;
}

// The six panel inks as sRGB (must match server palette.js) + their nibble codes.
static const UBYTE kPanelRGB[6][3] = {
    {0, 0, 0}, {255, 255, 255}, {255, 233, 0}, {200, 0, 0}, {0, 70, 200}, {0, 130, 60}
};
static const UBYTE kPanelCode[6] = {0, 1, 2, 3, 5, 6};
static UBYTE Nearest6Color(int r, int g, int b) {
    int best = 0; long bd = 1L << 30;
    for (int i = 0; i < 6; i++) {
        int dr = r - kPanelRGB[i][0], dg = g - kPanelRGB[i][1], db = b - kPanelRGB[i][2];
        long d = (long)dr * dr + (long)dg * dg + (long)db * db;
        if (d < bd) { bd = d; best = i; }
    }
    return kPanelCode[best];
}

// Read an in-memory 24-bit BMP (the REAL smooth image the server sends over HTTP)
// and reduce each pixel to the nearest of the 6 panel inks — the colour conversion
// happens HERE, on the device, not on the server.
UBYTE GUI_ReadBmp_RGB_6Color_buf(const UBYTE *data, UDOUBLE len, UWORD Xstart, UWORD Ystart)
{
    if (data == NULL || len < sizeof(BMPFILEHEADER) + sizeof(BMPINFOHEADER)) {
        printf("BMP buffer too small (%lu)\n", (unsigned long)len);
        return 0;
    }
    BMPFILEHEADER bmpFileHeader;
    BMPINFOHEADER bmpInfoHeader;
    memcpy(&bmpFileHeader, data, sizeof(BMPFILEHEADER));
    memcpy(&bmpInfoHeader, data + sizeof(BMPFILEHEADER), sizeof(BMPINFOHEADER));

    if ((bmpInfoHeader.biWidth == 1200) && (bmpInfoHeader.biHeight == 1600))
        Paint_SetRotate(0);
    else if ((bmpInfoHeader.biWidth == 1600) && (bmpInfoHeader.biHeight == 1200))
        Paint_SetRotate(90);

    if (bmpInfoHeader.biBitCount != 24) {
        printf("Bmp image is not 24 bitmap!\n");
        return 0;
    }

    const UBYTE *p   = data + bmpFileHeader.bOffset;
    const UBYTE *end = data + len;
    UBYTE Rdata[3];
    UBYTE color = 6;
    for (UDOUBLE y = 0; y < bmpInfoHeader.biHeight; y++) {
        for (UDOUBLE x = 0; x < bmpInfoHeader.biWidth; x++) {
            if (p + 3 > end) return 0;
            Rdata[0] = *p++; Rdata[1] = *p++; Rdata[2] = *p++;
            // Reduce the real image to the nearest of the 6 panel inks, on-device.
            color = Nearest6Color(Rdata[2], Rdata[1], Rdata[0]); // R, G, B (BMP is BGR)
            Paint_SetPixel(Xstart + x, Ystart + bmpInfoHeader.biHeight - 1 - y, color);
        }
        vTaskDelay(pdMS_TO_TICKS(1));
    }
    return 0;
}

