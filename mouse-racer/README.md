# Mouse Racer

Multiplayer top-down racing in the browser. You point; the tyres decide.

## Run

```bash
npm install
npm start            # http://localhost:3000
```

**Single HTML file:** `dist/mouse-racer.html` is the whole game in one file
(practice mode with bots, all images inlined). Open it straight from disk, no
server needed. Rebuild it after changes with `node tools/build-single.mjs`
(needs `esbuild` on the PATH, or set `ESBUILD=/path/to/esbuild`).

Open the URL in several tabs/browsers to race each other.

**Joining from the HTML file:** players don't need the project, only
`mouse-racer.html`. In it, open Settings → **Play online**, type the server's
address (e.g. `192.168.1.23:3000`, or a tunnel link like `https://xyz.trycloudflare.com`)
and press Join. The file remembers the server and rejoins it next time; Leave
goes back to practice. `mouse-racer.html?server=192.168.1.23:3000` works too. Up to 8 players.
`?offline` gives solo practice with bots, `?name=Max` sets your name,
`?server=wss://host` points the client at another server.

## Controls

The car steers itself and overtakes on its own. You only drive the pedals.

| Input | Effect |
|---|---|
| W / ↑ | Hold to drive: the longer you hold, the more gas (full after ~0.8 s). The automatic 5-speed gearbox changes up as you build speed (0 → 90% of top speed in ~9 s, top gear at ~7 s) |
| Let go of W | Coasts with a light lift-off slowdown: half speed after ~2.3 s, stopped after ~4.7 s |
| S / ↓ | Brake (stops in ~1.7 s from top speed); hold it at a standstill to reverse |
| Space | Handbrake |
| R | Back to the grid |
| Touch / click | Hold right half to drive, left half for hard brake |

**Game controller** (Xbox, or any pad your browser reports with the standard layout;
plug it in or pair it, then press any button so the browser notices it):

| Controller | Effect |
|---|---|
| RT (right trigger) | Gas, analog: squeeze halfway for half throttle |
| LT (left trigger) | Brake, analog; held at a standstill it reverses |
| A / X | Full gas / full brake as buttons |
| B or RB | Handbrake |
| Y or View | Back to the grid |
| Menu | Show / hide settings |

The controller rumbles when you spin or hit something hard (in browsers that
support it, e.g. Chrome and Edge). Online, trigger positions are sent to the
server as values 0–1, so analog pedals work in multiplayer too.

**Your car:** pick the road car or the prototype at the top of the settings
panel (remembered; online, other players see your choice). In practice the bots
drive the other one. Each car has a soft glow in its driver's colour, matching
the standings. Artwork: `public/cars/*.png` (cut out from a supplied image; if
it isn't yours, check you have the rights before sharing the game publicly).

**Settings panel** (top left, can be hidden):

| Slider | Range | What it does |
|---|---|---|
| Pace | 10–100% | Overall speed of everything (starts at 100%) |
| Tyre grip | 70–130% | Lower: the car slides sooner, so you brake earlier |
| Acceleration | 50–200% | How fast you build speed (shows the 0-to-top time) |
| Cars | 2–20 | Field size in practice: you plus up to 19 bots, you start last (restarts the race) |
| Bot speed | 85–110% | How hard the bots push (practice mode) |
| Bot mistakes | 0–200% | How often bots get corners wrong (practice mode) |

Easy / Normal / Hard set the last four at once. Pace, grip and acceleration
change the car itself, so online they apply to the whole room (like pace);
bot settings only apply in practice. Your choices are remembered.

The camera is fixed north-up at a constant zoom and follows your car.
In practice mode you start at the back of the grid, so there are cars to pass.

**Your driving line** runs around the entire lap. The stretch just ahead of
the car is a live prediction of where it will really go if your pedals stay
where they are: hold W and it bends wider through the next corners, lift or
brake and it tightens back. That stretch is green on the road, amber near the
edge, red where you'd run off ("TOO FAST · BRAKE"), and blue on an overtaking
line. The rest of the loop follows the racing line in green. The line eases
between frames rather than snapping.

**Overtaking** is automatic and gentle, and can start on about 80% of the lap.
A pass only adjusts the line slightly, shared between the two cars: the passer
moves at most 42 px off the racing line and the car being passed eases at most
32 px the other way (wheels on the kerb if needed), so together they leave
~22 px of air side by side. Where the racing line runs along one edge, the car
with more room does more of the moving. Both moves happen at a shallow angle
(about 5°), spread over distance. Near a tight corner your driver will still
dive down the inside; around the outside it waits for room. If the road runs out
mid-pass it tucks back in, and after an abandoned pass it waits a couple of
seconds before trying again. There's no speed boost.

**Contact costs speed.** A bump is mostly inelastic (it doesn't fire the car in
front down the road), the car doing the hitting loses the most (from ~1% for a
tap up to 45%), the car that's hit loses some too and gets twisted off line.
Low-speed jostling, like squeezing past a stopped car, isn't penalised.

**Stopped cars:** a car that's stopped or crawling counts as an obstacle, not a
race. Cars behind see it earlier and steer round it properly (this is the one
case where they may swerve, up to the kerb if needed), without waiting for a straight.

**Bot mistakes:** each bot rolls the dice approaching every corner (about a
third of corners, more for sloppier bots) and may:
- miss the apex: turn in badly and sweep wide, sometimes onto the kerb or grass,
  leaving the inside open;
- brake too early and crawl through the corner;
- get back on the gas late on the way out.
Your driver treats a mistake ahead as an opening and goes for the gap straight
away (with the same gentle passing line, and only if there's room). With mistakes switched off, a decent driver starting last stays last;
with them, it climbs to 2nd–3rd in a couple of laps.

**Stuck recovery:** a bot stuck nose-in against another car for a second backs
up briefly and pulls out again. Behind a stopped car it waits up to 2 s for a way
round, then creeps forward (which lets the nose-in check back it out). As a last
resort, any bot that hasn't moved for 3 s backs up and tries again. These matter in
big fields, where two cars can otherwise end up tangled in the run-off waiting for
each other.

**Big fields:** `node tools/build-single.mjs --cars 20 --out dist/mouse-racer-20cars.html`
builds a file that starts with 20 cars (or add `?cars=20` to the URL). In a
10-minute headless 20-car race at 100% pace every car keeps lapping (no car stopped
longer than 4 s), and the sim costs ~1.3 ms per step for all 20 cars.

**Follow limiter (bots only):** when a bot is close behind a car it can't pass
yet, it eases off and brakes as needed so it doesn't run into the back of it.
Players never get this: your pedals are always yours. If you close up on a car,
it's up to you to lift, or your driver pulls out to pass when there's room.

## Track artwork (`public/track/*.png`, `drawTrackArt` in `game.js`)

The circuit is painted with pieces cut from a supplied track tile sheet: sheet
grass and gravel (re-synthesised into seamless textures), sheet asphalt with a
white edge line, red/white kerbs through every bend, gravel traps and tyre walls on
the outside of the tight bends, armco along both barriers, chevron boards, cones,
floodlights, a start gantry the cars drive under, and a pit lane with garages
beside the start straight. Only the look changed: the layout is still the spline
in `track.js`, so handling, bots and the racing line are unaffected. The art is
drawn once at load into an off-screen canvas, so it costs nothing per frame.
As with the cars, check you have the rights to the sheet before sharing publicly.

## Racing line and autopilot (`track.js`, `world.js`)

- The racing line hits the apex of every bend: the tightest point of each bend
  is held to the inside (about 20 px off the kerb), and the rest of the line is
  smoothed around those points (minimum curvature, solved at load). That gives
  outside → apex → outside through each corner. Going right onto the kerb looked
  more dramatic but was ~5% slower per lap on these S-bends; this is ~2% faster
  than the old middle-of-the-road line. Tune with `APEX_MARGIN` in `track.js`.
- Each car aims at a point a short way ahead on that line (pure pursuit).
- Overtaking (`decideLanes`) runs only on the authority (server, or the
  browser in practice mode); the chosen passing line travels in the car state.
- A speed profile gives the fastest safe speed at each point (grip limit in
  corners, braking zones worked backwards). Bots and the coloured line use it.

## Gearbox and difficulty

- **Gearbox** (`GEARS` in `physics.js`): five gears, each with a rev limit and
  pull. It changes up near the limiter with a 0.22 s pause in drive, and down as
  you slow. The HUD shows the gear and a 12-block rev counter.
- **Difficulty:** grip 800, apexes ~25 px off the kerb (`APEX_MARGIN` 24), grass
  limits you to ~27% of road speed (`SURFACES.grass`), and a barrier hit keeps only half your speed.
  At the default pace, holding W the whole lap is about 10% slower than braking
  properly, and runs off several times a lap.

## How the car handles (`public/shared/physics.js`)

1. **Intent:** the autopilot's aim point → target steering angle (capped,
   and the steering rack turns at a finite speed). W/S drive gas and brake
   pedals that ramp up rather than switching on instantly.
2. **Turn rate:** kinematic bicycle model, `ω = v·tan(steer)/wheelbase`,
   capped at `yawOverGrip × grip / v` (1.45). At the limit the car can rotate a bit
   faster than its tyres can turn its path, so a slide builds up.
3. **Tyres:** each step, sideways velocity is cancelled up to `grip·dt`. Past
   ~4° of slip the tyres let go and grip only `slideGrip` (64%) until the slide
   is back under ~2°; gas while sliding takes more grip away (`powerSlide`).
   So a corner taken too fast drifts out on the exit and keeps going wide until
   the tyres bite again, instead of snapping back to the line.
4. **Oversteer and spins:** once a slide starts, the tail keeps stepping out
   the way it's going (`rearLoose`), more so if you brake, lift off or floor it
   mid-slide. Past ~60° of slide the steering can't catch it and the car spins
   (`spinAngle`). At the default pace spins start at ~10% over the corner limit;
   driving at or under the limit never spins.
   **Recovery:** facing the wrong way (more than ~110° off the track direction),
   the car turns round on full lock, the short way unless that would swing it
   into the barrier, and rejoins the racing line once it's within ~45°. You keep
   the pedals. Against the barrier, the barrier helps it round. Bots ride a spin
   out and turn round gently.
5. **Load slip (the weight pushing you wide):** the harder a corner loads the
   tyres, the more they let the car slide sideways while still gripping, growing
   with the square of the load. So the car drifts out of the racing line
   gradually as you carry more speed, long before the tyres let go: at the
   default pace, ~15 px wide at full corner speed, ~35 px at 5% over, and off
   the road at ~15% over. (`loadSlip`, `loadSlipFrom`)
6. **Friction circle:** a tyre has one budget of grip shared between turning
   and accelerating/braking. Full brakes, or full gas in a low gear (lots of
   torque at the wheels), leave only about half the cornering grip. Floor it out
   of a slow corner and the car runs wide; feed the gas in as it straightens.
   (`tractionShare`, `wheelTorque`)
7. **Surfaces:** grass has less grip, less engine and much more drag.

Tuning lives in the `CAR` and `SURFACES` objects. Good knobs: `grip`
(cornering), `steerGain` (twitchiness), `brake` (stopping power),
`brakeRise` / `gasRise` (pedal feel), `drag` (how far you coast),
`yawResponse` (weight/inertia feel). The in-game PACE slider scales all speeds.

## Netcode

- **Server authoritative**, fixed 60 Hz, snapshots at 20 Hz (`server/server.js`).
- Clients send `{seq, gas, brake, handbrake}` every tick; steering is computed on both sides.
- **Own car:** client-side prediction with the same shared physics; on each
  snapshot it resets to the server state, replays unacknowledged inputs, and
  hides the correction with a decaying render offset.
- **Other cars:** interpolated 100 ms in the past between snapshots.
- Laps are counted on the server with ordered checkpoints, so shortcuts don't count.
- A client can't speed-hack: the server consumes at most 3 inputs per tick.

## Layout

```
public/index.html        page
public/game.js           client: input, prediction, rendering, HUD
public/shared/physics.js car model (shared)
public/shared/track.js   spline track, nearest-point queries (shared)
public/shared/world.js   walls, laps, car collisions, bots (shared)
server/server.js         static files + WebSocket game server
```

## Next steps worth doing

- Rooms / lobbies and a proper race start (countdown, fixed lap count, results).
- Binary snapshots (e.g. Float32Array) once player counts grow.
- Track editor: the track is just a list of control points in `track.js`.
- Predict car-vs-car contact on the client to soften bump corrections.
