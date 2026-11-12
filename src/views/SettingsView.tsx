import { PageHeader } from "@/components/shell/PageHeader";
import { AppearanceSection, RenderingSection } from "@/components/settings/PreferencesSections";
import { AboutSection, DataSection } from "@/components/settings/DataAboutSections";
import { PathsSection } from "@/components/settings/PathsSection";
import { ApiSection } from "@/components/settings/ApiSection";
import { StartupSection } from "@/components/settings/StartupSection";
import { PrivacySection } from "@/components/settings/PrivacySection";

export function SettingsView() {
  return (
    <div className="page-width fade-up">
      <PageHeader title="Settings" subtitle="Appearance, starting with your computer, privacy, rendering defaults, where FireVoice keeps its files, and the API for your own tools." />
      <div className="flex flex-col gap-4">
        <AppearanceSection />
        <StartupSection />
        <PrivacySection />
        <RenderingSection />
        <DataSection />
        <PathsSection />
        <ApiSection />
        <AboutSection />
      </div>
    </div>
  );
}
