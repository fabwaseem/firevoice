import { PageHeader } from "@/components/shell/PageHeader";
import { ServerSection } from "@/components/settings/ServerSection";
import { AppearanceSection, RenderingSection } from "@/components/settings/PreferencesSections";
import { AboutSection, DataSection } from "@/components/settings/DataAboutSections";
import { PathsSection } from "@/components/settings/PathsSection";

export function SettingsView() {
  return (
    <div className="mx-auto max-w-[760px] fade-up">
      <PageHeader title="Settings" subtitle="Server connection, appearance and rendering defaults." />
      <div className="flex flex-col gap-4">
        <ServerSection />
        <AppearanceSection />
        <RenderingSection />
        <DataSection />
        <PathsSection />
        <AboutSection />
      </div>
    </div>
  );
}
