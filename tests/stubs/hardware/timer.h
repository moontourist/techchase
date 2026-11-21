#pragma once
#include <stdint.h>
extern uint32_t sim_now;
static inline uint32_t time_us_32(void) { return sim_now; }
