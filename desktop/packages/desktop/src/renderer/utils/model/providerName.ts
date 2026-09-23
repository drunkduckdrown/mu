/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isSubscriptionProvider } from '@/common/kyrn/login';
import { BUILTIN_PROVIDER_NAMES } from '@/common/kyrn/models';

/**
 * A model provider as people know it: a subscription by its product, in the sign-in screens' words (ChatGPT for
 * `openai-codex`), one of pi's built-in providers by its maker's name, and any other one (set up by hand) by its id.
 */
export const providerDisplayName = (t: (key: string) => string, id: string): string =>
  isSubscriptionProvider(id) ? t(`mu.welcome.login.providers.${id}.name`) : (BUILTIN_PROVIDER_NAMES[id] ?? id);
