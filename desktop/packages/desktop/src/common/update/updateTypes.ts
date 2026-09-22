/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { UpdateErrorInfo } from './updateErrors';

export interface GitHubReleaseAsset {
  name: string;
  /** Download URL: the release asset on GitHub. */
  url: string;
  /** A second URL tried when the first fails. */
  fallbackUrl?: string;
  size: number;
  contentType?: string;
}

export interface UpdateReleaseInfo {
  tagName: string;
  version: string;
  name?: string;
  body?: string;
  htmlUrl: string;
  publishedAt?: string;
  prerelease: boolean;
  draft: boolean;
  assets: GitHubReleaseAsset[];
  recommendedAsset?: GitHubReleaseAsset;
}

export interface UpdateCheckResult {
  currentVersion: string;
  updateAvailable: boolean;
  latest?: UpdateReleaseInfo;
}

export interface UpdateCheckRequest {
  includePrerelease?: boolean;
  /** Defaults to mu's own repository, qybaihe/MU, when omitted. */
  repo?: string;
}

export interface UpdateDownloadRequest {
  /** Optional caller-provided id so renderer can match progress events immediately. */
  downloadId?: string;
  url: string;
  /** Fallback URL tried when the primary URL fails. */
  fallbackUrl?: string;
  file_name?: string;
}

export interface UpdateDownloadResult {
  downloadId: string;
  file_path: string;
}

export interface UpdateDownloadCancelRequest {
  downloadId: string;
}

export type InstallerLastFailureKind = 'app-cannot-be-closed';
export type InstallerLastFailurePhase = 'customCheckAppRunning';

export interface InstallerLastFailureMarker {
  schemaVersion: 1;
  kind: InstallerLastFailureKind;
  phase: InstallerLastFailurePhase;
  silent: true;
  updated: true;
  retryCount: number;
  instDir: string;
  logPath: string;
  at: string;
  blockers?: unknown[];
}

export type UpdateDownloadStatus = 'starting' | 'downloading' | 'completed' | 'error' | 'cancelled';

export interface UpdateDownloadProgressEvent {
  downloadId: string;
  status: UpdateDownloadStatus;
  receivedBytes: number;
  totalBytes?: number;
  percent?: number;
  bytesPerSecond?: number;
  file_path?: string;
  /** Raw failure message, for logs and as a secondary detail. */
  error?: string;
  /** Why it failed; the renderer shows the translated text for it. */
  errorInfo?: UpdateErrorInfo;
}

// Auto-updater status types (electron-updater)
export type AutoUpdateStatusType =
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'preparing-install'
  | 'error'
  | 'cancelled';

export interface AutoUpdateProgress {
  bytesPerSecond: number;
  percent: number;
  transferred: number;
  total: number;
}

export interface AutoUpdateStatus {
  status: AutoUpdateStatusType;
  /** New version available for download. */
  version?: string;
  /** Current installed version — reflects the dev debug override when set. */
  currentVersion?: string;
  releaseDate?: string;
  releaseNotes?: string;
  progress?: AutoUpdateProgress;
  /** Raw failure message, for logs and as a secondary detail. */
  error?: string;
  /** Why it failed; the renderer shows the translated text for it. */
  errorInfo?: UpdateErrorInfo;
}

export interface AutoUpdateReadyResult {
  ready: boolean;
  version?: string;
  currentVersion?: string;
  releaseNotes?: string;
  filePath?: string;
  size?: number;
}
