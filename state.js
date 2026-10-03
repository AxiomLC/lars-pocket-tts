/* =====================================================================
   state.js — the voice state machine (single source of truth for "what is the app doing")

   States
     idle       nothing happening; mic closed
     listening  mic open, waiting for / collecting the user's words
     thinking   utterance sent; waiting for the first LLM token / first audio
     speaking   assistant audio is playing (mic may be open for barge-in)

   Normal turn:   idle → listening → thinking → speaking → listening (re-arm) → …
   Barge-in:      speaking → listening
   Typed input:   idle → thinking → speaking → idle
   Any state can fall back to idle (Stop button, errors, mic blocked).

   Also holds three user-facing flags so they are not loose globals:
     armed     the user pressed Talk: keep the mic recognizer alive/restarting
     rearm     re-open the mic when reply audio starts (the "Re-arm" toggle)
     testMode  Echo test running: log what the mic hears, never act on it
   ===================================================================== */
'use strict';

const State = (() => {
  // Which transitions are expected. Unexpected ones are still applied but reported (helps spot bugs).
  const ALLOWED = {
    idle:      ['listening', 'thinking'],
    listening: ['idle', 'thinking'],
    thinking:  ['idle', 'listening', 'speaking'],
    speaking:  ['idle', 'listening', 'thinking'],
  };

  let current = 'idle';
  const subscribers = [];

  return {
    armed: false,
    rearm: true,
    testMode: false,

    get current() { return current; },
    is(...names) { return names.includes(current); },

    /** Move to a new state. `label` is optional display text, e.g. "Echo test…". */
    set(next, label) {
      const prev = current;
      const expected = prev === next || ALLOWED[prev].includes(next) || next === 'idle';
      current = next;
      subscribers.forEach(fn => fn(prev, next, label, expected));
    },

    /** Register fn(prev, next, label, expected) — called after every set(). */
    onChange(fn) { subscribers.push(fn); },
  };
})();