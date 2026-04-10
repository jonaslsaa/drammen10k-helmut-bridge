import type { Split } from "./helmut";
import type { AllLeaderboards } from "./ul";
import { secondsToTime, timeToSeconds } from "./time";

interface FinishFallbackResult {
  splits: Split[];
  usedUlFinish: boolean;
  finishTime?: string;
}

function getFinishEntries(
  leaderboards: AllLeaderboards,
  category: string,
) {
  if (/\b(women|female)\b/i.test(category)) {
    return leaderboards.women["10km_leaderboard"].entries;
  }

  if (/\b(men|male)\b/i.test(category)) {
    return leaderboards.men["10km_leaderboard"].entries;
  }

  return leaderboards.mixed["10km_leaderboard"].entries;
}

export function applyUlFinishFallback({
  splits,
  leaderboards,
  totalKm,
  category,
}: {
  splits: Split[];
  leaderboards: AllLeaderboards | null;
  totalKm: number;
  category: string;
}): FinishFallbackResult {
  const lastSplit = splits.at(-1);
  if (!lastSplit || lastSplit.km >= totalKm || !leaderboards) {
    return { splits, usedUlFinish: false };
  }

  const remainingKm = totalKm - lastSplit.km;

  // Only fill a missing finish split when exactly one km marker is missing.
  if (remainingKm !== 1) {
    return { splits, usedUlFinish: false };
  }

  const finishEntries = getFinishEntries(leaderboards, category);
  const leaderFinish = finishEntries[0]?.time;
  if (!leaderFinish) {
    return { splits, usedUlFinish: false };
  }

  const finishSecs = timeToSeconds(leaderFinish);
  const prevSecs = timeToSeconds(lastSplit.split);

  if (!Number.isFinite(finishSecs) || !Number.isFinite(prevSecs) || finishSecs <= prevSecs) {
    return { splits, usedUlFinish: false };
  }

  return {
    splits: [
      ...splits,
      {
        km: totalKm,
        split: leaderFinish,
        last_km: secondsToTime(finishSecs - prevSecs),
        projected_finish: leaderFinish,
      },
    ],
    usedUlFinish: true,
    finishTime: leaderFinish,
  };
}
