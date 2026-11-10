import { lazy, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashRouter, RouterProvider } from "react-router";
import { AppShell } from "@/components/shell/AppShell";
import { RouteError } from "@/components/shell/RouteError";
import { UpdateGate } from "@/components/shell/UpdateGate";
import { StartupGate } from "@/components/onboarding/StartupGate";
import { HomeView } from "@/views/HomeView";

// Pages load when first opened, so the app starts from a small bundle. Home ships with it.
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
const SpeakView = page(() => import("@/views/SpeakView"), "SpeakView");
const VoicesView = page(() => import("@/views/VoicesView"), "VoicesView");
const TranscribeView = page(() => import("@/views/TranscribeView"), "TranscribeView");
const JobsView = page(() => import("@/views/JobsView"), "JobsView");
const EnginesView = page(() => import("@/views/EnginesView"), "EnginesView");
const StylesView = page(() => import("@/views/StylesView"), "StylesView");
const DictionaryView = page(() => import("@/views/DictionaryView"), "DictionaryView");
const ProjectsView = page(() => import("@/views/ProjectsView"), "ProjectsView");
const VoiceChangerView = page(() => import("@/views/VoiceChangerView"), "VoiceChangerView");
const DialogueView = page(() => import("@/views/DialogueView"), "DialogueView");
const DubbingView = page(() => import("@/views/DubbingView"), "DubbingView");
const SoundView = page(() => import("@/views/SoundView"), "SoundView");
const ProjectEditorView = page(() => import("@/views/ProjectEditorView"), "ProjectEditorView");
const SettingsView = page(() => import("@/views/SettingsView"), "SettingsView");
const HistoryView = page(() => import("@/views/HistoryView"), "HistoryView");
const StatsView = page(() => import("@/views/StatsView"), "StatsView");
const ToolsView = page(() => import("@/views/ToolsView"), "ToolsView");
const DictationView = page(() => import("@/views/DictationView"), "DictationView");

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 10_000 },
  },
});

// Hash routing keeps deep links working inside the Tauri webview (file-based frontendDist) and in the browser.
const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <HomeView /> },
      { path: "speak", element: <SpeakView /> },
      { path: "history", element: <HistoryView /> },
      { path: "voices", element: <VoicesView /> },
      { path: "voices/:voiceId", element: <VoicesView /> },
      { path: "transcribe", element: <TranscribeView /> },
      { path: "dictation", element: <DictationView /> },
      { path: "jobs", element: <JobsView /> },
      { path: "jobs/:jobId", element: <JobsView /> },
      { path: "engines", element: <EnginesView /> },
      { path: "stats", element: <StatsView /> },
      { path: "styles", element: <StylesView /> },
      { path: "styles/:styleName", element: <StylesView /> },
      { path: "dictionary", element: <DictionaryView /> },
      { path: "projects", element: <ProjectsView /> },
      { path: "changer", element: <VoiceChangerView /> },
      { path: "tools", element: <ToolsView /> },
      { path: "dialogue", element: <DialogueView /> },
      { path: "dub", element: <DubbingView /> },
      { path: "sound", element: <SoundView /> },
      { path: "projects/:projectId", element: <ProjectEditorView /> },
      { path: "settings", element: <SettingsView /> },
    ],
  },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <UpdateGate>
        <StartupGate>
          <RouterProvider router={router} />
        </StartupGate>
      </UpdateGate>
    </QueryClientProvider>
  );
}
