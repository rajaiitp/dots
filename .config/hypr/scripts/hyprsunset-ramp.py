#!/usr/bin/env python3
"""
hyprsunset-ramp — smooth, sunset-based colour-temperature ramp for hyprsunset.

hyprsunset (v0.4) only supports hard-jump time profiles. This daemon instead
drives `hyprctl hyprsunset temperature <K>` continuously, interpolating between
a DAY and NIGHT temperature across a transition window centred on the real
local sunrise/sunset (computed from latitude/longitude, no network needed).

Schedule (each day):
  • Full DAY temp until sunset transition begins
  • Smooth ramp DAY -> NIGHT across a window straddling sunset
  • Full NIGHT temp overnight
  • Smooth ramp NIGHT -> DAY across a window straddling sunrise

Config via env or the constants below. Runs forever; re-evaluates every STEP_SECS.
"""

import datetime as dt
import math
import os
import subprocess
import sys
import time

# ---- configuration --------------------------------------------------------
LAT = float(os.environ.get("HYPRSUNSET_LAT", "52.4"))
LON = float(os.environ.get("HYPRSUNSET_LON", "4.9"))

DAY_TEMP = int(os.environ.get("HYPRSUNSET_DAY", "5600"))
NIGHT_TEMP = int(os.environ.get("HYPRSUNSET_NIGHT", "3700"))

# Full width of each transition, in minutes, centred on sunrise / sunset.
# e.g. 90 -> ramp starts 45 min before sunset and ends 45 min after.
TRANSITION_MIN = int(os.environ.get("HYPRSUNSET_TRANSITION_MIN", "90"))

# Cap the *effective* sunset time so the warm ramp never starts unreasonably
# late during long summer evenings. "HH:MM" (local tz), or "" to disable.
# With TRANSITION_MIN=90 the ramp starts (TRANSITION_MIN/2) min before this,
# so "20:15" -> ramp begins at 19:30. On winter days when real sunset is earlier
# than the cap, the cap is ignored and the real sunset is used.
SUNSET_MAX_TIME = os.environ.get("HYPRSUNSET_SUNSET_MAX", "20:15")

# How often to recompute and re-apply the temperature.
STEP_SECS = int(os.environ.get("HYPRSUNSET_STEP_SECS", "60"))

# Only send hyprctl when the target changes by at least this many K (avoids spam).
MIN_DELTA_K = int(os.environ.get("HYPRSUNSET_MIN_DELTA_K", "15"))
RUNTIME_DIR = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
STATUS_FILE = os.path.join(RUNTIME_DIR, "hyprsunset-ramp.status")
OVERRIDE_FILE = os.path.join(RUNTIME_DIR, "hyprsunset-ramp.override")
OVERRIDE_MIN = 2500
OVERRIDE_MAX = 6500

# Fallback clock times if sunrise/sunset can't be computed (polar day/night).
FALLBACK_SUNRISE = dt.time(7, 0)
FALLBACK_SUNSET = dt.time(19, 0)


# ---- sunrise / sunset (NOAA algorithm, local, no deps) --------------------
def _sun_event(date, lat, lon, sunrise):
    """Return UTC datetime of sunrise (sunrise=True) or sunset for `date`.
    Returns None if the sun doesn't cross the horizon (polar day/night)."""
    N = date.toordinal() - dt.date(date.year, 1, 1).toordinal() + 1
    lng_hour = lon / 15.0
    t = N + ((6 if sunrise else 18) - lng_hour) / 24.0

    M = (0.9856 * t) - 3.289
    L = M + (1.916 * math.sin(math.radians(M))) \
          + (0.020 * math.sin(math.radians(2 * M))) + 282.634
    L %= 360

    RA = math.degrees(math.atan(0.91764 * math.tan(math.radians(L)))) % 360
    RA += (math.floor(L / 90) * 90) - (math.floor(RA / 90) * 90)
    RA /= 15.0

    sin_dec = 0.39782 * math.sin(math.radians(L))
    cos_dec = math.cos(math.asin(sin_dec))

    zenith = 90.833  # official sunrise/sunset (incl. refraction)
    cos_h = (math.cos(math.radians(zenith)) - (sin_dec * math.sin(math.radians(lat)))) \
            / (cos_dec * math.cos(math.radians(lat)))
    if cos_h > 1 or cos_h < -1:
        return None  # sun never rises / never sets on this date

    H = (360 - math.degrees(math.acos(cos_h))) if sunrise \
        else math.degrees(math.acos(cos_h))
    H /= 15.0

    T = H + RA - (0.06571 * t) - 6.622
    UT = (T - lng_hour) % 24
    h = int(UT)
    m = int((UT - h) * 60)
    s = int((((UT - h) * 60) - m) * 60)
    return dt.datetime(date.year, date.month, date.day, h % 24, m % 60, s % 60,
                       tzinfo=dt.timezone.utc)


def _parse_hhmm(s):
    try:
        hh, mm = s.strip().split(":", 1)
        return dt.time(int(hh), int(mm))
    except Exception:
        return None


SUNSET_MAX = _parse_hhmm(SUNSET_MAX_TIME) if SUNSET_MAX_TIME else None


def local_event(date, sunrise):
    utc = _sun_event(date, LAT, LON, sunrise)
    if utc is None:
        base = FALLBACK_SUNRISE if sunrise else FALLBACK_SUNSET
        local = dt.datetime.combine(date, base).astimezone()
    else:
        local = utc.astimezone()  # convert to local tz
    if not sunrise and SUNSET_MAX is not None:
        cap = dt.datetime.combine(date, SUNSET_MAX).astimezone(local.tzinfo)
        if local > cap:
            local = cap
    return local


# ---- interpolation --------------------------------------------------------
def smoothstep(x):
    """Ease-in-out 0..1 for a natural-looking ramp (no abrupt starts/stops)."""
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def target_temp(now):
    """Compute the desired temperature for local datetime `now`."""
    half = dt.timedelta(minutes=TRANSITION_MIN / 2)
    today = now.date()

    sunrise = local_event(today, sunrise=True)
    sunset = local_event(today, sunrise=False)

    # Transition windows.
    sr0, sr1 = sunrise - half, sunrise + half   # night -> day
    ss0, ss1 = sunset - half, sunset + half     # day -> night

    if now < sr0:
        # Before dawn: could be tail of yesterday's sunset ramp -> night.
        return NIGHT_TEMP
    if sr0 <= now <= sr1:
        f = smoothstep((now - sr0) / (sr1 - sr0))
        return round(NIGHT_TEMP + (DAY_TEMP - NIGHT_TEMP) * f)
    if sr1 < now < ss0:
        return DAY_TEMP
    if ss0 <= now <= ss1:
        f = smoothstep((now - ss0) / (ss1 - ss0))
        return round(DAY_TEMP + (NIGHT_TEMP - DAY_TEMP) * f)
    return NIGHT_TEMP  # after sunset window


# ---- apply ----------------------------------------------------------------
def read_override():
    try:
        value = int(open(OVERRIDE_FILE, encoding="utf-8").read().strip())
    except (OSError, ValueError):
        return None
    return value if OVERRIDE_MIN <= value <= OVERRIDE_MAX else None


def apply_temp(k):
    try:
        subprocess.run(["hyprctl", "hyprsunset", "temperature", str(k)],
                       check=False, capture_output=True, timeout=5)
        with open(STATUS_FILE, "w", encoding="utf-8") as status:
            status.write(f"{k}\n")
    except Exception as e:
        print(f"[hyprsunset-ramp] hyprctl failed: {e}", file=sys.stderr)


def main():
    last = None
    # Log the day's schedule once at start.
    now = dt.datetime.now().astimezone()
    sr = local_event(now.date(), True)
    ss = local_event(now.date(), False)
    cap_note = f" (capped from real sunset)" if (SUNSET_MAX is not None and
        _sun_event(now.date(), LAT, LON, False) is not None and
        _sun_event(now.date(), LAT, LON, False).astimezone() >
        dt.datetime.combine(now.date(), SUNSET_MAX).astimezone(ss.tzinfo)) else ""
    print(f"[hyprsunset-ramp] lat={LAT} lon={LON} "
          f"sunrise={sr:%H:%M} sunset={ss:%H:%M}{cap_note} "
          f"window={TRANSITION_MIN}min day={DAY_TEMP}K night={NIGHT_TEMP}K",
          flush=True)

    while True:
        now = dt.datetime.now().astimezone()
        override = read_override()
        if override is not None:
            k = override
            changed = last != k
            mode = "override"
        else:
            k = target_temp(now)
            changed = last is None or abs(k - last) >= MIN_DELTA_K
            mode = "automatic"

        if changed:
            apply_temp(k)
            print(f"[hyprsunset-ramp] {now:%H:%M} -> {k}K ({mode})", flush=True)
            last = k
        time.sleep(STEP_SECS)


if __name__ == "__main__":
    main()
