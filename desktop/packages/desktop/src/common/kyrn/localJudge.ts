/**
 * The local judge (Laya on Core ML) as the app manages it: installed from the settings with one click after the person
 * agrees to the download, started and stopped there. The main process runs the harness's own script,
 * `kyrn/bin/kyrn-judge-local setup|start|stop`, so the app and `mu judge` in a terminal do the same thing.
 */

export type LocalJudgeAction = 'setup' | 'start' | 'stop';

/** ok: this machine can run it. platform: not an Apple Silicon Mac. uv: installing needs `uv`, which is missing. */
export type LocalJudgeSupport = 'ok' | 'platform' | 'uv';

export type LocalJudgeTask = {
  id: number;
  action: LocalJudgeAction;
  phase: 'running' | 'done' | 'failed';
  /** The script's last lines, for progress and for why it failed. English, as the script writes them. */
  output: string[];
};

export type LocalJudgeState = {
  support: LocalJudgeSupport;
  /** The Python environment and the weights are there. */
  installed: boolean;
  /** Its health check answers on this machine. */
  running: boolean;
  /** The address it answers on. */
  url: string;
  /** What the app runs now or ran last; unset before the first action of this app run. */
  task?: LocalJudgeTask;
};

/** What installing downloads, about: the Python packages (~125 MB) and Laya's weights (~680 MB). */
export const LOCAL_JUDGE_DOWNLOAD_MB = 800;
