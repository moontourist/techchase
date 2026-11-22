#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>

#include "utilities/latch.h"
#include "hardware/structs/usb.h"

uint32_t sim_now = 0;
sim_dpram_t sim_dpram;

#define EP 1

static uint32_t rnd(uint32_t n) { return n ? (uint32_t)(rand() % n) : 0; }

typedef struct
{
    const char *name;
    bool usb;
    bool latch_on;
    uint32_t phase;
    uint32_t period;
    uint32_t period_jitter;
    uint32_t read_us, read_jitter;
    uint32_t pass_max;
    uint32_t long_task_us;
    bool creeping_stalls;
} scenario_s;

static bool latch_allows(uint32_t runtime, uint32_t now)
{
    bool valid;
    uint32_t period = 0;
    uint32_t start = latch_next_start_us(&valid, &period);
    if (!valid) return true;
    int32_t left = (int32_t)(start - now);
    if (left <= 0) return left < -300;
    uint32_t need = runtime + 20;
    if (need < (uint32_t)left) return true;
    if (need >= period / 2) return (uint32_t)left > period / 2;
    return false;
}

static bool run(const scenario_s *sc)
{
    memset(&sim_dpram, 0, sizeof(sim_dpram));
    sim_now = 12345;
    srand(1);
    latch_set_enabled(sc->latch_on);
    if (sc->usb) latch_usb_start(); else latch_jb_start();

    enum { FW_IDLE, FW_READING, FW_BUILDING, FW_LONGTASK } fw = FW_IDLE;
    uint32_t fw_until = sim_now, next_pass = sim_now;
    bool frame_mark = false, sendit = false, due_pending = false, deferred_sof = false;
    uint32_t due_us = 0, next_long = sim_now + 3000;
    uint32_t jb_interval_next = sim_now + 1000, jb_trigger_us = 0; bool build_due = false;
    uint32_t next_poll = sim_now + 777;
    uint32_t xfer_done_at = 0; bool xfer_pending = false;
    uint32_t warm_end = sim_now + 300000;
    const uint32_t stalls_at = sim_now + 1000000;
    bool stalls_done = false;

    const uint32_t end = sim_now + 3300000;
    for (; sim_now < end; sim_now++)
    {
        if (sim_now == warm_end) latch_stats_reset();

        if (sc->usb)
        {
            if (sim_now % 1000 == 0) { latch_usb_sof_isr(); deferred_sof = true; }
            if (sim_now % 1000 == sc->phase && (sim_dpram.ep_buf_ctrl[EP].in & USB_BUF_CTRL_AVAIL))
            { xfer_pending = true; xfer_done_at = sim_now + 35; }
            if (xfer_pending && sim_now == xfer_done_at)
            { sim_dpram.ep_buf_ctrl[EP].in = 0; xfer_pending = false; latch_usb_xfer_isr(); }
        }
        else if (sim_now == next_poll)
        {
            { latch_stats_s a, b; latch_stats_get(&a); latch_jb_poll_isr(sim_now); latch_stats_get(&b);
              if (getenv("SIMDBG") && b.misses != a.misses) printf("  miss at t=%u (since start %u us) mode=%u lead=%u read_start=%u\n", sim_now, sim_now - 12345, b.mode, b.lead_us, latch_input_read_us()); }
            next_poll += sc->period + rnd(2 * sc->period_jitter + 1) - sc->period_jitter;
        }

        if (fw != FW_IDLE)
        {
            if (sim_now < fw_until) continue;
            if (fw == FW_READING) { latch_input_read_end(); fw = FW_IDLE; }
            else if (fw == FW_BUILDING)
            {
                if (sc->usb)
                {
                    sim_dpram.ep_buf_ctrl[EP].in = USB_BUF_CTRL_AVAIL;
                    latch_usb_armed(latch_input_read_us());
                }
                else latch_jb_snapshot(latch_input_read_us());
                fw = FW_IDLE;
            }
            else fw = FW_IDLE;
            next_pass = sim_now;
        }
        if (sim_now < next_pass) continue;
        next_pass = sim_now + 5 + rnd(sc->pass_max);

        if (frame_mark)
        {
            frame_mark = false;
            latch_input_read_begin();
            fw = FW_READING; fw_until = sim_now + sc->read_us + rnd(sc->read_jitter);
            continue;
        }

        if (sc->usb)
        {
            if (deferred_sof)
            {
                deferred_sof = false;
                if (!latch_usb_active())
                { frame_mark = true; sendit = true; if (latch_enabled()) { due_us = sim_now; due_pending = true; } }
            }
            if (latch_usb_due())
            { frame_mark = true; sendit = true; due_us = sim_now; due_pending = true; }

            bool ready = !(sim_dpram.ep_buf_ctrl[EP].in & USB_BUF_CTRL_AVAIL) && !xfer_pending;
            if (sendit && !ready && latch_usb_endpoint_busy()) { sendit = false; due_pending = false; }
            if (sendit && ready)
            {
                if (!due_pending || (int32_t)(latch_input_read_us() - due_us) >= 0)
                {
                    due_pending = false; sendit = false;
                    fw = FW_BUILDING; fw_until = sim_now + 30;
                    if (sc->creeping_stalls && !stalls_done && (int32_t)(sim_now - stalls_at) >= 0)
                    {
                        latch_stats_s now_st;
                        latch_stats_get(&now_st);
                        const uint32_t ready_max = now_st.lead_us - now_st.guard_us;
                        const uint32_t ready_now = sim_now - due_us + 30;
                        uint32_t want = 2 * ready_max + 40;
                        if (want > 880) want = 880;
                        if (now_st.lead_us >= 950) stalls_done = true;
                        else if (want > ready_now) fw_until += want - ready_now;
                    }
                    continue;
                }
            }
        }
        else
        {
            bool trig;
            if (latch_jb_locked()) trig = latch_jb_due();
            else { trig = (int32_t)(sim_now - jb_interval_next) >= 0; if (trig) jb_interval_next += 1000; }
            if (trig) { frame_mark = true; build_due = true; jb_trigger_us = sim_now; }
            else if (build_due && (!latch_enabled() || (int32_t)(latch_input_read_us() - jb_trigger_us) >= 0 ||
                                   (sim_now - jb_trigger_us) > 2000))
            { build_due = false; fw = FW_BUILDING; fw_until = sim_now + 40; continue; }
        }

        if (sc->long_task_us && (int32_t)(sim_now - next_long) >= 0 && latch_allows(sc->long_task_us, sim_now))
        {
            next_long = sim_now + 3000;
            fw = FW_LONGTASK; fw_until = sim_now + sc->long_task_us;
        }
    }

    latch_stats_s st;
    latch_stats_get(&st);
    static const char *modes[] = {"off", "usb-frame", "usb-LATE", "jb-free", "jb-LOCKED"};
    printf("%-38s mode=%-9s n=%-6u age avg %4u  min %4u  max %5u us  misses %-4u lead %3u guard %3u %s %u\n",
           sc->name, modes[st.mode & 0x7F], st.count, st.age_avg_us, st.age_min_us, st.age_max_us, st.misses,
           st.lead_us, st.guard_us, sc->usb ? "phase" : "period", st.phase_us);
    if (sc->usb) latch_usb_stop(); else latch_jb_stop();
    if (sc->creeping_stalls && (st.mode & 0x7F) != LATCH_MODE_USB_LATE)
    {
        printf("FAIL  late-latch stayed off after slow reports pushed its lead past a frame\n");
        return false;
    }
    return true;
}

int main(void)
{
    const scenario_s s[] = {
        {"USB poll@120us  STOCK",          true,  false, 120, 0, 0, 80, 20, 40, 150, false},
        {"USB poll@120us  late-latch",     true,  true,  120, 0, 0, 80, 20, 40, 150, false},
        {"USB poll@500us  STOCK",          true,  false, 500, 0, 0, 80, 20, 40, 150, false},
        {"USB poll@500us  late-latch",     true,  true,  500, 0, 0, 80, 20, 40, 150, false},
        {"USB poll@900us  STOCK",          true,  false, 900, 0, 0, 80, 20, 40, 150, false},
        {"USB poll@900us  late-latch",     true,  true,  900, 0, 0, 80, 20, 40, 150, false},
        {"USB poll@120us  late, 800us task",true, true,  120, 0, 0, 80, 20, 40, 800, false},
        {"USB poll@300us  late, slow loop", true, true,  300, 0, 0, 120, 60, 120, 300, false},
        {"USB poll@120us  late, slow reports",true, true, 120, 0, 0, 80, 20, 40, 150, true},
        {"GC console 16.7ms STOCK",        false, false, 0, 16683, 4, 80, 20, 40, 150, false},
        {"GC console 16.7ms poll-lock",    false, true,  0, 16683, 4, 80, 20, 40, 150, false},
        {"GC adapter 1ms   STOCK",         false, false, 0, 1000, 2, 80, 20, 40, 150, false},
        {"GC adapter 1ms   poll-lock",     false, true,  0, 1000, 2, 80, 20, 40, 150, false},
        {"GC adapter 600us poll-lock",     false, true,  0, 600, 2, 80, 20, 40, 150, false},
        {"GC irregular polls (jitter 40%)",false, true,  0, 2000, 800, 80, 20, 40, 150, false},
    };
    int failures = 0;
    for (unsigned i = 0; i < sizeof(s) / sizeof(s[0]); i++)
        failures += run(&s[i]) ? 0 : 1;
    return failures ? 1 : 0;
}
