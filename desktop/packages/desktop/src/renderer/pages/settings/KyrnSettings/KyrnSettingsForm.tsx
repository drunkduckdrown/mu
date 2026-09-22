import React from 'react';
import SettingsArea from './SettingsArea';

/**
 * The entry both hosts import (the settings page and the settings modal). The single form that used to be here
 * grew into the settings area: sections, a provider manager and one save bar.
 */
export default function KyrnSettingsForm() {
  return <SettingsArea />;
}
