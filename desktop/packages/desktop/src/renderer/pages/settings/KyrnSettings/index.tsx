import React from 'react';
import { Navigate, useParams } from 'react-router-dom';
import SettingsPageWrapper from '../components/SettingsPageWrapper';
import { SECTIONS, type SectionId } from './draft';
import { muTabPath } from './navigation';
import SettingsArea from './SettingsArea';

const isSection = (value: string | undefined): value is SectionId => SECTIONS.includes(value as SectionId);

/** `/settings/kyrn/:section`: one route for all sections, so switching between them keeps the unsaved draft. */
export default function KyrnSettingsPage() {
  const { section } = useParams();
  if (!isSection(section)) return <Navigate to={`/settings/${muTabPath('models')}`} replace />;
  return (
    <SettingsPageWrapper>
      <SettingsArea section={section} />
    </SettingsPageWrapper>
  );
}
