import { PageHeader } from "@/components/shell/PageHeader";
import { AppearanceSection, RenderingSection } from "@/components/settings/PreferencesSections";
import { AboutSection, DataSection } from "@/components/settings/DataAboutSections";
import { PathsSection } from "@/components/settings/PathsSection";

export function SettingsView() {
  return (
    <div className="mx-auto max-w-[760px] fade-up">
      <PageHeader title="Settings" subtitle="Appearance, rendering defaults and where FireVoice keeps its files." />
      <div className="flex flex-col gap-4">
        <AppearanceSection />
        <RenderingSection />
        <DataSection />
        <PathsSection />
        <AboutSection />
      </div>
    </div>
  );
}
