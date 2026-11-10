import { PageHeader } from "@/components/shell/PageHeader";
import { AppearanceSection, RenderingSection } from "@/components/settings/PreferencesSections";
import { AboutSection, DataSection } from "@/components/settings/DataAboutSections";
import { PathsSection } from "@/components/settings/PathsSection";
import { ApiSection } from "@/components/settings/ApiSection";

export function SettingsView() {
  return (
    <div className="mx-auto max-w-[760px] fade-up">
      <PageHeader title="Settings" subtitle="Appearance, rendering defaults, where FireVoice keeps its files, and the API for your own tools." />
      <div className="flex flex-col gap-4">
        <AppearanceSection />
        <RenderingSection />
        <DataSection />
        <PathsSection />
        <ApiSection />
        <AboutSection />
      </div>
    </div>
  );
}
