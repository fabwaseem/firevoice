import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashRouter, RouterProvider } from "react-router";
import { AppShell } from "@/components/shell/AppShell";
import { RouteError } from "@/components/shell/RouteError";
import { HomeView } from "@/views/HomeView";
import { SpeakView } from "@/views/SpeakView";
import { VoicesView } from "@/views/VoicesView";
import { TranscribeView } from "@/views/TranscribeView";
import { JobsView } from "@/views/JobsView";
import { EnginesView } from "@/views/EnginesView";
import { StylesView } from "@/views/StylesView";
import { DictionaryView } from "@/views/DictionaryView";
import { ProjectsView } from "@/views/ProjectsView";
import { VoiceChangerView } from "@/views/VoiceChangerView";
import { DialogueView } from "@/views/DialogueView";
import { DubbingView } from "@/views/DubbingView";
import { ProjectEditorView } from "@/views/ProjectEditorView";
import { SettingsView } from "@/views/SettingsView";

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
      { path: "voices", element: <VoicesView /> },
      { path: "voices/:voiceId", element: <VoicesView /> },
      { path: "transcribe", element: <TranscribeView /> },
      { path: "jobs", element: <JobsView /> },
      { path: "jobs/:jobId", element: <JobsView /> },
      { path: "engines", element: <EnginesView /> },
      { path: "styles", element: <StylesView /> },
      { path: "styles/:styleName", element: <StylesView /> },
      { path: "dictionary", element: <DictionaryView /> },
      { path: "projects", element: <ProjectsView /> },
      { path: "changer", element: <VoiceChangerView /> },
      { path: "dialogue", element: <DialogueView /> },
      { path: "dub", element: <DubbingView /> },
      { path: "projects/:projectId", element: <ProjectEditorView /> },
      { path: "settings", element: <SettingsView /> },
    ],
  },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
