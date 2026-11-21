#pragma once
#include <stdint.h>
#define USB_BUF_CTRL_AVAIL 0x00000400u
typedef struct { volatile uint32_t in, out; } sim_ep_buf_ctrl_t;
typedef struct { sim_ep_buf_ctrl_t ep_buf_ctrl[16]; } sim_dpram_t;
extern sim_dpram_t sim_dpram;
#define usb_dpram (&sim_dpram)
