// Game sound, synthesised live with the Web Audio API: no audio files to download or
// license. The audio graph runs on the browser's audio thread; each frame the game only
// nudges a few parameters (pitch, volume, filter), so it costs next to nothing.
//
//   engine     your car: two detuned oscillators through a soft clipper and a filter;
//              pitch follows the revs (so gear changes are heard), brightness the gas
//   others     the 3 nearest other cars, quieter, panned left/right by where they are
//   tyres      band-passed noise, louder the harder the car slides or locks up
//   gravel     low rumble when you're off the road
//   crowd      murmur near the stands, swelling into a cheer as cars pass
//   one-shots  impacts (barrier, contact) and a lap chime
//
// Browsers only allow sound after the player has touched / clicked / pressed a key,
// so nothing is created until unlock() is called from such an event.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function createSound() {
  let ac = null, master = null, noiseBuf = null;
  let engine = null, others = [], tyres = null, gravel = null, crowd = null;
  let enabled = true, volume = 0.7;

  function noiseSource() {
    const src = ac.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    src.start(0, Math.random() * 2);
    return src;
  }

  function makeEngine(level) {
    const out = ac.createGain(); out.gain.value = 0;
    const filt = ac.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 900; filt.Q.value = 3;
    const shaper = ac.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const x = i / 128 - 1; curve[i] = Math.tanh(x * 2.2); }
    shaper.curve = curve;
    const o1 = ac.createOscillator(); o1.type = 'sawtooth';
    const o2 = ac.createOscillator(); o2.type = 'square';
    const o3 = ac.createOscillator(); o3.type = 'sawtooth';        // a touch of detune: a rougher, real-engine beat
    const g1 = ac.createGain(); g1.gain.value = 0.5;
    const g2 = ac.createGain(); g2.gain.value = 0.35;
    const g3 = ac.createGain(); g3.gain.value = 0.25;
    o1.connect(g1).connect(shaper); o2.connect(g2).connect(shaper); o3.connect(g3).connect(shaper);
    shaper.connect(filt).connect(out);
    o1.start(); o2.start(); o3.start();
    const pan = ac.createStereoPanner ? ac.createStereoPanner() : null;
    if (pan) out.connect(pan).connect(master); else out.connect(master);
    return { out, filt, o1, o2, o3, pan, level };
  }

  function makeNoise(type, freq, q) {
    const out = ac.createGain(); out.gain.value = 0;
    const f = ac.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    noiseSource().connect(f).connect(out).connect(master);
    return { out, f };
  }

  function build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ac = new AC();
    master = ac.createGain(); master.gain.value = enabled ? volume : 0;
    // a gentle limiter so several loud things at once don't clip
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 6; comp.attack.value = 0.005; comp.release.value = 0.2;
    master.connect(comp).connect(ac.destination);
    noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    engine = makeEngine(0.32);
    others = [makeEngine(0.13), makeEngine(0.13), makeEngine(0.13)];
    tyres = makeNoise('bandpass', 2300, 3.5);
    gravel = makeNoise('lowpass', 260, 0.7);
    crowd = makeNoise('bandpass', 950, 0.6);
    crowd.bright = makeNoise('bandpass', 2600, 1.2);                 // the "whoo" on top of a cheer
    document.addEventListener('visibilitychange', () => {
      if (!ac) return;
      if (document.hidden) ac.suspend(); else if (enabled) ac.resume();
    });
    return true;
  }

  // smooth parameter change (no clicks)
  const set = (param, v, tc = 0.05) => param.setTargetAtTime(v, ac.currentTime, tc);

  // engine pitch from revs: idle ~38 Hz up to ~190 Hz at the limiter
  function drive(e, rpm, load, vol, panX) {
    const f = 38 + clamp(rpm, 0, 1.05) * 150;
    set(e.o1.frequency, f, 0.03); set(e.o2.frequency, f * 0.5, 0.03); set(e.o3.frequency, f * 1.007, 0.03);
    set(e.filt.frequency, 500 + load * 2400 + rpm * 900, 0.05);
    set(e.out.gain, vol * e.level, 0.06);
    if (e.pan) set(e.pan.pan, clamp(panX, -0.9, 0.9), 0.1);
  }

  return {
    unlock() {
      if (!ac && !build()) return;
      if (enabled && ac.state !== 'running') ac.resume();
    },
    setEnabled(on) {
      enabled = on;
      if (!ac) return;
      set(master.gain, on ? volume : 0, 0.05);
      if (on) ac.resume();
    },
    setVolume(v) { volume = clamp(v, 0, 1); if (ac && enabled) set(master.gain, volume, 0.05); },
    get enabled() { return enabled; },
    get volume() { return volume; },

    /**
     * Once per frame.
     * me:     { rpm, gas, speed, top, slide, braking, offroad }   (speed/top in world units/s)
     * others: [{ x, y, rpm, speed }] already sorted nearest first, with dx (screen offset) for panning
     * crowd:  0..1 how loud the nearest stands are, cheer: 0..1 how much of that is cheering
     */
    update(me, others3, crowdLevel, cheer) {
      if (!ac || ac.state !== 'running') return;
      const sp = me.speed / Math.max(me.top, 1);
      drive(engine, me.rpm, me.gas, 0.55 + me.gas * 0.45, 0);
      for (let i = 0; i < others.length; i++) {
        const o = others3[i];
        if (!o) { set(others[i].out.gain, 0, 0.1); continue; }
        drive(others[i], o.rpm, 0.6, o.vol, o.pan);
      }
      // tyres: sliding sideways, or locking up under hard braking at speed
      const squeal = clamp(me.slide, 0, 1) * 0.5 + (me.braking && sp > 0.3 ? 0.18 * sp : 0);
      set(tyres.out.gain, squeal, 0.04);
      set(tyres.f.frequency, 1900 + me.slide * 900, 0.08);
      set(gravel.out.gain, me.offroad ? clamp(sp * 1.4, 0, 0.45) : 0, 0.06);
      set(crowd.out.gain, crowdLevel * (0.12 + cheer * 0.45), 0.25);
      set(crowd.bright.out.gain, crowdLevel * cheer * 0.18, 0.2);
    },

    // a thump: how hard (0..1)
    impact(strength) {
      if (!ac || ac.state !== 'running') return;
      const t = ac.currentTime, s = clamp(strength, 0.05, 1);
      const g = ac.createGain(); g.gain.setValueAtTime(0.9 * s, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500 + 900 * s;
      const n = noiseSource(); n.connect(f).connect(g).connect(master); n.stop(t + 0.4);
      const o = ac.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.2);
      const og = ac.createGain(); og.gain.setValueAtTime(0.7 * s, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
      o.connect(og).connect(master); o.start(t); o.stop(t + 0.3);
    },

    // a short tone: start lights (and the higher one for GO)
    beep(freq, dur = 0.15, level = 0.25) {
      if (!ac || ac.state !== 'running') return;
      const t = ac.currentTime;
      const o = ac.createOscillator(); o.type = 'square'; o.frequency.value = freq;
      const f = ac.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq * 3;
      const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + 0.005);
      g.gain.setValueAtTime(level, t + dur); g.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.08);
      o.connect(f).connect(g).connect(master); o.start(t); o.stop(t + dur + 0.1);
    },

    // lap complete: two rising notes (three for a best lap)
    lap(best) {
      if (!ac || ac.state !== 'running') return;
      const notes = best ? [784, 988, 1319] : [784, 1175];
      notes.forEach((f, i) => {
        const t = ac.currentTime + i * 0.11;
        const o = ac.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
        const g = ac.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.22, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.connect(g).connect(master); o.start(t); o.stop(t + 0.4);
      });
    },
  };
}
