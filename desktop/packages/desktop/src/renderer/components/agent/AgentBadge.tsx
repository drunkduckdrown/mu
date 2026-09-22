/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { resolveAgentLogo, useAgentLogos } from '@/renderer/utils/model/agentLogo';
import { iconColors } from '@/renderer/styles/colors';
import { Robot } from '@icon-park/react';
import React, { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import ThemedLogo from './ThemedLogo';

export type AgentBadgeProps = {
  /** Agent backend type */
  backend?: string;
  /** Display name for the agent */
  agent_name?: string;
  /** Custom agent logo (SVG path or emoji string) */
  agentLogo?: string;
  /** Whether the logo is an emoji */
  agentLogoIsEmoji?: boolean;
  /** Whether the explicit assistant logo is intentionally empty. */
  agentLogoIsFallback?: boolean;
  /** Assistant ID — when provided, clicking the badge navigates to AssistantSettings */
  assistantId?: string;
};

/**
 * Render agent logo from custom logo, backend logo, or fallback Robot icon.
 *
 * The logo is decorative (`alt=''`): every place that shows it puts the agent's or the conversation's name right
 * beside it, and an alt text built from a raw backend id ("openai logo") would be English in every language.
 * `agent_name` is accepted for the callers' convenience and not read.
 */
export const AgentLogoIcon: React.FC<
  Pick<AgentBadgeProps, 'backend' | 'agentLogo' | 'agentLogoIsEmoji' | 'agentLogoIsFallback' | 'agent_name'>
> = ({ backend, agentLogo, agentLogoIsEmoji, agentLogoIsFallback }) => {
  const logos = useAgentLogos();
  const logoContent = (() => {
    if (agentLogoIsFallback) {
      return <Robot theme='outline' size={16} fill={iconColors.primary} />;
    }
    if (agentLogo) {
      if (agentLogoIsEmoji) {
        return <span className='text-14px leading-none'>{agentLogo}</span>;
      }
      return <ThemedLogo src={agentLogo} alt='' className='block w-16px h-16px object-contain' />;
    }
    const logo = resolveAgentLogo(logos, { backend });
    if (logo) {
      return <ThemedLogo src={logo} alt='' className='block w-16px h-16px object-contain' />;
    }
    return <Robot theme='outline' size={16} fill={iconColors.primary} />;
  })();

  return (
    <span className='inline-flex w-16px h-16px items-center justify-center shrink-0 leading-none'>{logoContent}</span>
  );
};

/**
 * AgentBadge - Agent identity badge (logo + name)
 *
 * When `assistantId` is provided, clicking navigates to AssistantSettings editor.
 * Otherwise renders as a static display badge.
 */
const AgentBadge: React.FC<AgentBadgeProps> = ({
  backend,
  agent_name,
  agentLogo,
  agentLogoIsEmoji,
  agentLogoIsFallback,
  assistantId,
}) => {
  const navigate = useNavigate();
  const handleClick = useCallback(() => {
    if (!assistantId) return;
    navigate(`/settings/assistants?highlight=${encodeURIComponent(assistantId)}`);
  }, [assistantId, navigate]);

  return (
    <div
      className={`flex items-center gap-2 bg-2 w-fit rounded-full px-[8px] py-[2px] ${assistantId ? 'cursor-pointer hover:bg-3' : ''}`}
      data-testid='agent-badge'
      onClick={handleClick}
    >
      <AgentLogoIcon
        backend={backend}
        agent_name={agent_name}
        agentLogo={agentLogo}
        agentLogoIsEmoji={agentLogoIsEmoji}
        agentLogoIsFallback={agentLogoIsFallback}
      />
      <span className='text-sm text-t-primary'>{agent_name || backend}</span>
    </div>
  );
};

export default AgentBadge;
