/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

/**
 * One row of a settings panel: its title in the body text colour and weight of every settings row (mu's own pages
 * draw theirs the same way), the sentence under it, and its control on the right.
 */
const PreferenceRow: React.FC<{
  label: string;
  children: React.ReactNode;
  description?: string;
}> = ({ label, children, description }) => (
  <div className='flex items-center justify-between gap-24px py-12px'>
    <div className='flex-1 min-w-0'>
      <div className='text-14px font-500 leading-22px text-t-primary'>{label}</div>
      {/* Balanced lines: a sentence never leaves one or two characters alone on its last line. */}
      {description && (
        <div className='mt-2px text-12px leading-18px text-t-secondary' style={{ textWrap: 'balance' }}>
          {description}
        </div>
      )}
    </div>
    <div className='flex-shrink-0'>{children}</div>
  </div>
);

export default PreferenceRow;
