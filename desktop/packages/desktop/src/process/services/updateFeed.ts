/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CdnGenericProvider } from './cdnGenericProvider';
import type { CdnGenericProviderConfiguration } from './cdnGenericProvider';

export type CdnFeedOptions = CdnGenericProviderConfiguration & {
  updateProvider: typeof CdnGenericProvider;
};

/**
 * mu has no update feed yet, so the feed options refuse to build.
 *
 * AionUi's feed (static.aionui.com) would offer AionUi's installer as an update of mu. A GitHub
 * "releases/latest/download" base does not fit CdnGenericProvider either: the provider reads the
 * channel file from `<base>/latest*.yml` but every installer from `<base>/<version>/<file>`, while
 * GitHub serves assets from `releases/download/v<version>/<file>`, and `latest` skips the
 * pre-releases mu publishes. Self-update is off (MU_SELF_UPDATE in index.ts); turn it on only
 * together with a feed of mu's own that has the layout above.
 */
export function buildCdnFeedOptions(): CdnFeedOptions {
  throw new Error('mu has no update feed yet: self-update stays off until mu hosts one (see updateFeed.ts)');
}
