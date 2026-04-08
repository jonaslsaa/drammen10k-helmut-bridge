import { timeToSeconds, secondsToTime } from "./time";
import type { Split } from "./helmut";

export interface RaceState {
  event: string;
  category: string;
  status: "waiting" | "live" | "finished";
  race_clock: string;
  latest_km: number;
  total_km: number;
  estimated_position_km: number;
  pace_min_per_km: string;
  speed_kmh: number;
  projected_finish: string;
  splits: Split[];
}

interface ComputeRaceStateInput {
  now: Date;
  raceStart: Date;
  splits: Split[];
  totalKm: number;
  event: string;
  category: string;
  elapsedSecsOverride?: number;
}

export function computeRaceState({
  now,
  raceStart,
  splits,
  totalKm,
  event,
  category,
  elapsedSecsOverride,
}: ComputeRaceStateInput): RaceState {
  let elapsedSecs = (now.getTime() - raceStart.getTime()) / 1000;

  if (elapsedSecsOverride !== undefined) {
    elapsedSecs = elapsedSecsOverride;
  }

  const latestSplit = splits.at(-1) ?? null;
  const isFinished = latestSplit !== null && latestSplit.km >= totalKm;

  const status: RaceState["status"] =
    elapsedSecs < 0 ? "waiting" : isFinished ? "finished" : "live";

  const raceClock =
    status === "waiting"
      ? `-${secondsToTime(-elapsedSecs)}`
      : isFinished && latestSplit
        ? latestSplit.split
        : secondsToTime(elapsedSecs);

  let estimatedKm = 0;
  let paceMinPerKm = "0:00";
  let speedKmh = 0;
  let projectedFinish = "0:00";

  if (latestSplit && elapsedSecs > 0) {
    const lastKmSecs = timeToSeconds(latestSplit.last_km);
    const splitSecs = timeToSeconds(latestSplit.split);

    if (isFinished) {
      estimatedKm = totalKm;
    } else {
      const secsSinceLastSplit = elapsedSecs - splitSecs;
      if (secsSinceLastSplit > 0 && lastKmSecs > 0) {
        estimatedKm = latestSplit.km + secsSinceLastSplit / lastKmSecs;
      } else {
        estimatedKm = latestSplit.km;
      }
      estimatedKm = Math.min(estimatedKm, totalKm);
    }
    estimatedKm = Math.round(estimatedKm * 10) / 10;

    paceMinPerKm = latestSplit.last_km;
    speedKmh =
      lastKmSecs > 0 ? Math.round((3600 / lastKmSecs) * 10) / 10 : 0;
    projectedFinish = latestSplit.projected_finish;
  }

  return {
    event,
    category,
    status,
    race_clock: raceClock,
    latest_km: latestSplit?.km ?? 0,
    total_km: totalKm,
    estimated_position_km: estimatedKm,
    pace_min_per_km: paceMinPerKm,
    speed_kmh: speedKmh,
    projected_finish: projectedFinish,
    splits,
  };
}
