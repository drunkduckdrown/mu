import React, { Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Button, Result, Space } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import AppLoader from '@renderer/components/layout/AppLoader';
import DocumentTitle from '@renderer/components/layout/DocumentTitle';
import { useCrossSessionRateLimitNotice } from '@/renderer/hooks/system/useCrossSessionRateLimitNotice';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import StartupGate from '@/renderer/pages/settings/KyrnSettings/StartupGate';
const Conversation = React.lazy(() => import('@renderer/pages/conversation'));
const Guid = React.lazy(() => import('@renderer/pages/guid'));
const Welcome = React.lazy(() => import('@renderer/pages/welcome'));
const KyrnSettings = React.lazy(() => import('@renderer/pages/settings/KyrnSettings'));
const SkillsSettings = React.lazy(() => import('@renderer/pages/settings/SkillsSettings/SkillsHubSettings'));
const SkillDetailPage = React.lazy(() => import('@renderer/pages/settings/SkillsSettings/SkillDetailPage'));
const ToolsSettings = React.lazy(() => import('@renderer/pages/settings/ToolsSettings'));
const AppearanceSettings = React.lazy(() => import('@renderer/pages/settings/AppearanceSettings'));
const SystemSettings = React.lazy(() => import('@renderer/pages/settings/SystemSettings'));
const WebuiSettings = React.lazy(() => import('@renderer/pages/settings/WebuiSettings'));
const PetSettings = React.lazy(() => import('@renderer/pages/settings/PetSettings'));
const ArchivedSettings = React.lazy(() => import('@renderer/pages/settings/ArchivedSettings'));
const ExtensionSettingsPage = React.lazy(() => import('@renderer/pages/settings/ExtensionSettingsPage'));
const LoginPage = React.lazy(() => import('@renderer/pages/login'));
const ComponentsShowcase = React.lazy(() => import('@renderer/pages/TestShowcase'));
const ScheduledTasksPage = React.lazy(() => import('@renderer/pages/cron/ScheduledTasksPage'));
const TaskDetailPage = React.lazy(() => import('@renderer/pages/cron/ScheduledTasksPage/TaskDetailPage'));

const RouteFailure = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div role='alert' className='flex flex-1 items-center justify-center min-h-0'>
      <Result
        status='error'
        title={t('common.error')}
        extra={
          <Space>
            <Button type='primary' onClick={() => window.location.reload()}>
              {t('common.reload')}
            </Button>
            <Button onClick={() => void navigate('/guid')}>{t('common.back')}</Button>
          </Space>
        }
      />
    </div>
  );
};

class RouteErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[Route] Page failed to load or render', error, info.componentStack);
  }

  render() {
    return this.state.failed ? <RouteFailure /> : this.props.children;
  }
}

/** Keep page failures inside the route, preserving navigation and running agents. */
export const RouteContent: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { pathname } = useLocation();
  return (
    <RouteErrorBoundary key={pathname}>
      <Suspense fallback={<AppLoader />}>{children}</Suspense>
    </RouteErrorBoundary>
  );
};

const withRouteFallback = (Component: React.LazyExoticComponent<React.ComponentType>) => (
  <RouteContent>
    <Component />
  </RouteContent>
);

/**
 * Legacy `/settings/capabilities?tab=tools` deep links now map to the standalone
 * Tools page; everything else (skills tab or no tab) lands on the Skills page.
 */
const CapabilitiesRedirect: React.FC = () => {
  const { search } = useLocation();
  const tab = new URLSearchParams(search).get('tab');
  return <Navigate to={tab === 'tools' ? '/settings/tools' : '/settings/skills'} replace />;
};

const ProtectedLayout: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  const { status, user } = useAuth();
  const location = useLocation();
  // Mounted once for every authenticated route: the loop warning has to reach
  // the user even when they are looking at a THIRD conversation, which is the
  // whole reason it is a broadcast rather than an in-conversation banner.
  useCrossSessionRateLimitNotice(user?.id);

  if (status === 'checking') {
    return <AppLoader />;
  }

  if (status !== 'authenticated') {
    return <Navigate to='/login' replace />;
  }

  // Do not obstruct an existing task while the main process is being upgraded.
  return location.pathname.startsWith('/conversation/') ? (
    React.cloneElement(layout)
  ) : (
    <StartupGate>{React.cloneElement(layout)}</StartupGate>
  );
};

const PanelRoute: React.FC<{ layout: React.ReactElement }> = ({ layout }) => {
  const { status } = useAuth();

  return (
    <HashRouter>
      <DocumentTitle />
      <Routes>
        <Route
          path='/login'
          element={status === 'authenticated' ? <Navigate to='/guid' replace /> : withRouteFallback(LoginPage)}
        />
        <Route element={<ProtectedLayout layout={layout} />}>
          <Route index element={<Navigate to='/guid' replace />} />
          <Route path='/guid' element={withRouteFallback(Guid)} />
          <Route path='/welcome' element={withRouteFallback(Welcome)} />
          <Route path='/conversation/:id' element={withRouteFallback(Conversation)} />
          <Route path='/team/:id' element={<Navigate to='/guid' replace />} />
          <Route path='/settings/kyrn/:section?' element={withRouteFallback(KyrnSettings)} />
          <Route path='/settings/model' element={<Navigate to='/settings/kyrn' replace />} />
          <Route path='/assistants' element={<Navigate to='/settings/kyrn' replace />} />
          {/* Assistants moved out of Settings to a top-level entry; keep a redirect
              so old deep links / back-nav still land on the new page. */}
          <Route path='/settings/assistants' element={<Navigate to='/assistants' replace />} />
          <Route path='/settings/agent' element={<Navigate to='/settings/kyrn' replace />} />
          <Route path='/settings/agent/:id/repair' element={<Navigate to='/settings/kyrn' replace />} />
          {/* Skills and Tools are top-level settings entries. */}
          <Route path='/settings/skills' element={withRouteFallback(SkillsSettings)} />
          <Route path='/settings/skills/import-history' element={withRouteFallback(SkillsSettings)} />
          <Route path='/settings/skills/detail/:skillName' element={withRouteFallback(SkillDetailPage)} />
          <Route path='/settings/tools' element={withRouteFallback(ToolsSettings)} />
          {/* Legacy routes — the previous combined "Capabilities" page is now two pages. */}
          <Route path='/settings/capabilities' element={<CapabilitiesRedirect />} />
          <Route
            path='/settings/capabilities/skills/import-history'
            element={<Navigate to='/settings/skills/import-history' replace />}
          />
          <Route path='/settings/skills-hub' element={<Navigate to='/settings/skills' replace />} />
          <Route path='/settings/appearance' element={withRouteFallback(AppearanceSettings)} />
          <Route path='/settings/display' element={<Navigate to='/settings/appearance' replace />} />
          <Route path='/settings/webui' element={withRouteFallback(WebuiSettings)} />
          <Route path='/settings/pet' element={withRouteFallback(PetSettings)} />
          <Route path='/settings/archived' element={withRouteFallback(ArchivedSettings)} />
          <Route path='/settings/system' element={withRouteFallback(SystemSettings)} />
          <Route path='/settings/about' element={withRouteFallback(SystemSettings)} />
          <Route path='/settings/ext/:tabId' element={withRouteFallback(ExtensionSettingsPage)} />
          <Route path='/settings' element={<Navigate to='/settings/agent' replace />} />
          <Route path='/test/components' element={withRouteFallback(ComponentsShowcase)} />
          <Route path='/scheduled' element={withRouteFallback(ScheduledTasksPage)} />
          <Route path='/scheduled/:job_id' element={withRouteFallback(TaskDetailPage)} />
        </Route>
        <Route path='*' element={<Navigate to={status === 'authenticated' ? '/guid' : '/login'} replace />} />
      </Routes>
    </HashRouter>
  );
};

export default PanelRoute;
