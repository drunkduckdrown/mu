import React, { useState } from 'react';
import { Alert, Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import type { LoginStatus } from '@/common/kyrn/login';
import type { AvailableModels } from '@/common/kyrn/models';
import type { KyrnSettings } from '@/common/kyrn/types';
import type { Draft } from '../draft';
import { ErrorDetail } from '../fields/MuErrorMessage';
import BoardModelCard from '../providers/BoardModelCard';
import ProviderManager from '../providers/ProviderManager';
import { hiddenIds } from '../providers/removed';
import SectionShell from './SectionShell';

type ModelsSectionProps = {
  draft: Draft;
  base: KyrnSettings;
  available: AvailableModels;
  onDraft: (change: (draft: Draft) => Draft) => void;
};

/**
 * Every provider behind the models (subscriptions and endpoints), and the model that writes the plain-language board.
 * A conversation's model and thinking level are picked in its send box, and a new one starts with the last pick.
 */
export default function ModelsSection({ draft, base, available, onDraft }: ModelsSectionProps) {
  const { t } = useTranslation();
  const inRouter = useInRouterContext();
  const [accounts, setAccounts] = useState<LoginStatus['signedIn']>([]);
  const { models } = draft.settings;
  const setModels = (patch: Partial<KyrnSettings['models']>) =>
    onDraft((now) => ({ ...now, settings: { ...now.settings, models: { ...now.settings.models, ...patch } } }));
  // Removed here, but still in the snapshot of what mu last reported: offered neither as usable nor as a start.
  const hidden = hiddenIds([...models.providers.map((provider) => provider.id), ...models.foreign.map((e) => e.id)]);
  return (
    <SectionShell
      id='models'
      title={t('mu.sections.models')}
      description={t('mu.providers.lead')}
      actions={inRouter ? <ReopenGuide /> : undefined}
    >
      <ProviderManager
        draft={draft}
        base={base}
        available={available}
        onModels={setModels}
        onKeys={(providerKeys) => onDraft((now) => ({ ...now, providerKeys }))}
        onAccounts={setAccounts}
        hidden={hidden}
      >
        {models.problem ? (
          <Alert
            type='error'
            content={
              <>
                <div>{t('mu.providers.unreadable')}</div>
                <ErrorDetail>{models.problem}</ErrorDetail>
              </>
            }
          />
        ) : null}
        {models.commented ? <Alert type='warning' content={t('mu.providers.commented')} /> : null}
      </ProviderManager>
      <BoardModelCard
        settings={draft.settings}
        base={base}
        available={available}
        accounts={accounts}
        hidden={hidden}
        onChange={(model) =>
          onDraft((now) => ({
            ...now,
            settings: { ...now.settings, boardModel: { ...now.settings.boardModel, model } },
          }))
        }
      />
    </SectionShell>
  );
}

/** Opens the first-run guide again. Only where there is a router to open it in. */
function ReopenGuide() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Button size='small' type='text' data-testid='mu-open-welcome' onClick={() => navigate('/welcome')}>
      {t('mu.welcome.reopen')}
    </Button>
  );
}
