import { Brain, Branch, Components, LinkCloud, Memory, Shield } from '@icon-park/react';
import type { SectionId } from './draft';

/**
 * mu's settings as entries of the settings navigation itself, under "AI core": one entry per section, the models
 * first because they are what a new user sets up, then permissions. All of them are one page
 * (`/settings/kyrn/:section`), so an edit made in one section is still there, unsaved, when another is opened.
 */
export const MU_TABS = [
  { id: 'mu-models', section: 'models', Icon: LinkCloud },
  { id: 'mu-permissions', section: 'permissions', Icon: Shield },
  { id: 'mu-judges', section: 'judges', Icon: Brain },
  { id: 'mu-decisions', section: 'decisions', Icon: Branch },
  { id: 'mu-features', section: 'features', Icon: Components },
  { id: 'mu-context', section: 'context', Icon: Memory },
] as const satisfies readonly { id: string; section: SectionId; Icon: unknown }[];

export type MuTabId = (typeof MU_TABS)[number]['id'];

export const muTabPath = (section: SectionId): string => `kyrn/${section}`;
