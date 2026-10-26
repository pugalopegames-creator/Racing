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
`?offline` gives solo practice with bots, `?name=Max` sets your name (or type it in Settings → Your name: up to 10
characters, saved on the device so it's used every time you play or join a server;
renaming while online updates it for everyone),
`?server=wss://host` points the client at another server.

## Controls

One button, like a slot car: **hold to go, let go to slow down**. The car steers itself
along the racing line and overtakes on its own; your only job is the speed.

| Input | Effect |
|---|---|
| Hold W, ↑ or Space | Gas (it builds up over ~0.8 s; the automatic gearbox changes up as you go) |
| Hold anywhere on the screen (touch or mouse) | Gas |
| Controller right trigger | Gas, analog: half pressed = half gas |
| Let go | The car slows firmly, like a slot car's motor brake: from top speed to a stop in about 4 s. Lift before the corners |
| R (controller Y / View) | Back to the grid (in a practice / qualifying / race session: restart it) |
| M | Sound on / off |
| F | FPS counter on / off |

There's no brake, reverse or handbrake. **The marshal:** if you're stuck with the gas held
(nose in a barrier, tangled with another car), after 2 s your car is put back on the
racing line facing the right way ("Back on track"), like a slot car put back in its slot.

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
line (only when you're the one overtaking: when a car passes you, your car eases
aside but the line stays green). The rest of the loop follows the racing line in green. Where the prediction ends, the line curves
smoothly into the racing line (leaving along the predicted direction and meeting the
racing line along its own; the further off the line you are, the longer the merge)
instead of hopping straight to it, so braking no longer puts a kink in it. At the other end, the lap's racing line curves into
the back of the car the same way, so the whole line is one unbroken loop. The line eases
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

## Painted map (`public/track/painted.jpg`)

The circuit is drawn from a painted image of the whole map (trees, dirt paths, the
road and run-offs). The painting was warped slightly so its road sits exactly on the
road the cars drive (the spline in `track.js`), its stands were painted out, and its
outer edge fades into a matching grass tile (`grass_painted.png`) that the game uses
beyond the map. The game's own grandstands and fans are drawn on top. The painting
is 1,403 px wide for a 3,409-unit map, so it's drawn about 2.4× enlarged: a
higher-resolution painting can be dropped in as `painted.jpg` (any size with the same
3409:2724 shape) and is scaled automatically. Delete `painted.jpg` to go back to the
tile-sheet map described below.

**Performance note:** the painting is drawn over the tile-sheet map, not onto a
blank canvas. Same picture, but Chrome chooses how to keep a canvas from how it was
drawn: a map made from one big image draw was kept in a slow mode on graphics cards,
freezing the game for 1-2 s every few seconds (~14 FPS). Don't use
`imageSmoothingQuality = 'high'` there either: that alone made it slower still.

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

**Grandstands and fans:** ten stands (the eight unmarked designs from the stands
sheet, `public/track/standA–H.png`) sit behind the barriers, placed automatically:
front facing the track, clear of the road, pits and each other, spread round the lap
with a preference for the start/finish and the outside of the tight bends. About a
thousand fans sit on the benches (positions found from the artwork). Each stand's
crowd is drawn once at load into three images (two calm poses, one cheering with arms
and flags up); every frame the game copies one image per stand on screen. When a car
comes past, that stand's crowd jumps up and bounces, then settles after ~1.5 s. On a
simulated phone the crowds cost about 1 frame per second at the busiest spot.

## Sound (`public/sound.js`)

All sound is synthesised live with the Web Audio API (no audio files):
- **Engine:** your car's pitch follows the revs, so you hear each gear change; the
  tone brightens with the gas. The three nearest other cars have quieter engines,
  panned left/right by where they are.
- **Tyres** squeal when sliding or locking up; **gravel/grass** rumbles when you're off
  the road; **impacts** (barrier, contact) thump in proportion to the speed lost.
- **Crowd:** a murmur near the stands that swells into a cheer as cars pass.
- **Lap chime** (three notes for a best lap).

Settings → Sound (On/Off, volume), or **M** to mute. Browsers only allow audio after a
touch, click or key press, so sound starts with your first input. Audio pauses when
the tab is hidden. It runs on the browser's audio thread, so it doesn't cost frames.

## Game modes (Settings → Game mode, practice with bots)

| Mode | What happens |
|---|---|
| Free | Endless driving, best laps on the board (as before) |
| Practice | 3 minutes; when time's up, finish your lap. Ranked by best lap |
| Qualifying | An out lap, then 2 timed laps. Ranked by best timed lap; the order sets the grid for "Race from this grid" |
| Race | 6 laps from a standing start: five red lights come on one by one, then go out after a random pause. Live position (P2 / 4) in the lap panel, running order top right |

When you finish, a results table appears over the running game (times, gaps, best
laps; it keeps updating as the others finish), with buttons for the next session:
race again, qualify, race from the qualifying grid, free practice, or keep driving.
In a session, R restarts it (offline). Durations live in `MODES` in
`public/shared/session.js`.

**Online:** the same modes run on the server for the whole room. Anyone can start one
from Settings → Game mode or the results buttons; everyone is lined up on the grid
(qualifying order for "race from this grid"), held during the lights, and gets the
same live board and results table (the server sends the clock and the table 4×/s).
Online, R calls the marshal instead of restarting (you keep your place). A player
who joins mid-session starts from the grid.

## Player accounts (Supabase)

Settings → Account: **Sign in with Google**, or **Play as guest** (an account made on
the spot, kept on this device; "Add Google" later keeps its name and results). Signed
in, your name is the same on every device, and every online practice, qualifying or
race you finish is saved. **Leaderboard**: most wins, and fastest laps (only laps at
the standard settings, so times compare). **Delete account** (two clicks) removes the
account with its name and results. Offline races against bots aren't saved.

How it fits together:
- `public/account.js`: sign-in in the browser (Supabase Auth's web API, no library).
  Google sign-in runs in a popup with the PKCE flow and comes back through
  `public/auth-callback.html` on the game server.
- `server/accounts.js`: the server checks each player's sign-in with Supabase, keeps
  their profile name, saves results, and serves `/api/leaderboard` and
  `/api/account/delete`. Only the server touches the database (secret key).
- `supabase/schema.sql`: the tables (`profiles`, `results`) and the `leaderboard` view.
- `public/account-config.js`: the project URL and publishable key (public by design).

Server settings (Render → Environment): `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the
publishable key) and `SUPABASE_SERVICE_ROLE_KEY` (the secret key: never in the code).
Without them the server runs as before, without accounts; its log says
"(accounts on)" or "(accounts off)".

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

## Performance (phones)

**Settings → Graphics** (remembered per device):
- **Map:** Painted (the painted circuit) or Classic (built from the tile sheet).
- **Resolution:** Auto, High (2×), Low (1×), Lowest (0.7×). Auto estimates the screen's
  refresh rate (60/90/120/144 Hz…) and, every ~2 s, steps the drawing resolution down
  (2 → 1.5 → 1.25 → 1 → 0.85 → 0.75×) while the game averages under 90% of it. The FPS
  counter shows the resolution in use and the refresh rate it's aiming for.
- **Crowds:** Animated, Still or Off.

Map switching is memory-clean: each build uses a fresh full-size canvas that's
released right after it's cut into tiles, the previous tiles are released at once
(some phone browsers otherwise keep canvas memory until garbage collection), the
painting is decoded into an ImageBitmap that's closed when you go back to Classic,
and the edge grass comes from a canvas copy. (A phone reported Classic 120 FPS,
Painted 20, and only 60 back in Classic: painted mode was leaving something behind.)

On the simulated phone, resolution is by far the biggest lever (0.7× ran about
50% faster than 1×); the painted and classic maps cost the same.

- **Drawing resolution:** touch devices draw at most 1.5 device pixels per CSS
  pixel (phones are often 3×). If frames still average slower than ~40/s, the game
  drops to 1× by itself (once, after a few seconds of play).
- **Cars:** each car's drop shadow and colour glow are drawn once into small images
  and copied each frame, rather than blurred every frame (that was 40 blurs a frame
  with 20 cars).
- **Track:** the art is pre-rendered once; the start gantry's shadow is baked in, and
  the grass outside the map is one fill, drawn only when the view reaches the edge.
- **Driving line:** the prediction updates every other frame (the line eases between
  updates anyway), and only the on-screen part of the lap's racing line is drawn.
  Drawing the whole lap every frame was the biggest single cost on a phone.
- **Map tiles:** the pre-drawn map (~3,400 × 2,700 px) is cut into 1024-px tiles; each
  frame draws only the tiles on screen, and a skid mark only changes the tile it lands
  on. With one big image, browsers drawing on the graphics card can copy the whole
  map (~37 MB) every frame a skid mark changes it; now it's at most ~4 MB.
- **Bots:** looking up where other cars are on the track now searches near their last
  position instead of the whole track: the simulation step for 20 cars went from
  ~1.2 ms to ~0.3 ms (the server benefits too).

On a simulated phone (iPhone-sized screen at 3×, processor slowed 4×, no graphics
card), a 20-car race went from ~9 to ~27 frames per second. A real phone draws with
its graphics card, so expect better than that.

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
