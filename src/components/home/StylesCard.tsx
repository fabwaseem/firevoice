import { Link, useNavigate } from "react-router";
import { Card, CardBody, CardHeader, Chip, Skeleton } from "@/components/ui";
import { useStyles } from "@/lib/api/hooks";
import { useStudio } from "@/stores/studio";
import { titleCase } from "@/lib/utils";

export function StylesCard() {
  const styles = useStyles();
  const current = useStudio((s) => s.style);
  const set = useStudio((s) => s.set);
  const navigate = useNavigate();
  const list = (styles.data ?? []).slice(0, 10);

  return (
    <Card>
      <CardHeader
        title="Styles"
        description="Pick a delivery and jump into Speak."
        action={
          <Link to="/styles" className="text-[12.5px] font-medium text-fire hover:underline">
            All styles
          </Link>
        }
      />
      <CardBody>
        {styles.isLoading ? (
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-24 rounded-full" />
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {list.map((st) => (
              <Chip
                key={st.name}
                active={st.name === current}
                title={st.description}
                onClick={() => {
                  set({ style: st.name });
                  navigate("/speak");
                }}
              >
                {st.title || titleCase(st.name)}
              </Chip>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
