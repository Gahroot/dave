import { useState } from "react";
import {
  ActionIcon,
  Button,
  Card,
  Collapse,
  Group,
  Menu,
  Stack,
  Text,
  Textarea,
  Tooltip,
} from "@mantine/core";
import {
  ChevronDown as IconChevronDown,
  Ellipsis as IconDots,
  Eye as IconEye,
  EyeOff as IconEyeOff,
  Pin as IconPin,
  PinOff as IconPinnedOff,
} from "lucide-react";
import type { PortfolioProject, ProjectSummary } from "../../shared/types.ts";
import { EvidenceList } from "../components/EvidenceList.tsx";
import { EditedBadge, PinnedBadge, TechnicalActivityBadge } from "../components/Labels.tsx";
import { relative } from "../format.ts";
import { useDraftGuard } from "../hooks/useDraftGuard.ts";
import { parseRoute } from "../navigation.ts";

const QUESTIONS = [
  { key: "recentFocus", label: "Most recently worked on" },
  { key: "completed", label: "Appears completed" },
  { key: "unfinished", label: "Unfinished or blocked" },
  { key: "suggestedNextAction", label: "Next action" },
] as const;

/** Observed machine facts, phrased as activity rather than progress. */
function activityLine(p: PortfolioProject): string {
  const a = p.activity;
  const bits = [
    a.branch ? `${a.branch}${a.dirty ? ` · ${a.dirtyFileCount ?? "some"} uncommitted` : ""}` : null,
    a.lastCommitAt ? `commit ${relative(a.lastCommitAt)}` : null,
    a.sessionCount ? `${a.sessionCount} session(s), last ${relative(a.lastAgentSessionAt)}` : null,
    a.openTaskCount ? `${a.openTaskCount} open task(s)` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(" · ") : "No technical activity observed";
}

export function ProjectCard({
  project: p,
  onOverride,
  onCorrect,
  busy,
  section = "overview",
}: {
  section?: "overview" | "context";
  project: PortfolioProject;
  onOverride: (id: string, next: { pinned?: boolean; hidden?: boolean }) => void;
  onCorrect: (id: string, field: string, value: string) => Promise<ProjectSummary | null>;
  busy: boolean;
}) {
  const [showEvidence, setShowEvidence] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const s = p.summary;
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useDraftGuard(editing !== null, hash => { const destination = parseRoute(hash); const route = destination.destination === "connections" && destination.returnTo ? parseRoute(destination.returnTo) : destination; return route.destination === "projects" && route.id === p.id; });

  return (
    <Card withBorder radius="md" padding="md">
      <Stack gap="xs">
        <Group justify="space-between" wrap="wrap" align="flex-start">
          <Stack gap={2}>
            <Group gap="xs">
              <Text fw={500}>{section === "context" ? "Source details" : "Project notes"}</Text>
              {p.override.pinned && <PinnedBadge />}
              {s.edited && <EditedBadge />}
              {!p.exists && (
                <Tooltip label="The directory was not found on disk">
                  <Text size="xs" c="red">
                    missing
                  </Text>
                </Tooltip>
              )}
            </Group>
            <Text size="xs" c="dimmed" hidden={section !== "context"}>
              {p.canonicalPath}
            </Text>
          </Stack>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label={`Options for ${p.name}`} loading={busy}>
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={p.override.pinned ? <IconPinnedOff size={14} /> : <IconPin size={14} />}
                onClick={() => onOverride(p.id, { pinned: !p.override.pinned })}
              >
                {p.override.pinned ? "Unpin" : "Pin to Active"}
              </Menu.Item>
              <Menu.Item
                leftSection={p.override.hidden ? <IconEye size={14} /> : <IconEyeOff size={14} />}
                onClick={() => onOverride(p.id, { hidden: !p.override.hidden })}
              >
                {p.override.hidden ? "Unhide" : "Hide"}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>

        <Stack gap="sm" hidden={section !== "overview"}>
          {[...QUESTIONS].sort((a, b) => Number(b.key === "suggestedNextAction") - Number(a.key === "suggestedNextAction")).map(({ key, label }) => {
            const value = s[key];
            const action = key === "suggestedNextAction";
            const controlLabel = action ? "Choose/update next action" : `Correct ${label}`;
            return <Stack key={key} gap={4} className={action ? "project-next-action" : "project-note"}>
              <Text size="xs" c="dimmed">{action ? (s.edited && s.nextActionEditedAt && Number.isFinite(Date.parse(s.nextActionEditedAt)) && value?.trim() ? "Chosen next action" : "Suggested next action") : label}</Text>
              {editing === key ? <Stack gap="xs" data-summary-editing>
                <Textarea aria-label={controlLabel} autoFocus autosize maxLength={400} value={draft} disabled={isSaving || busy}
                  description={`${draft.length}/400 characters`} onChange={(e) => setDraft(e.currentTarget.value)} />
                {saveError && <Text role="alert" c="red" size="sm">{saveError}</Text>}
                <Group gap="xs">
                  <Button loading={isSaving} disabled={busy} onClick={async () => {
                    if (isSaving) return;
                    setIsSaving(true); setSaveError(null);
                    try {
                      const saved = await onCorrect(p.id, key, draft);
                      if (saved) setEditing(null);
                      else setSaveError("Not saved. Your draft is retained; retry Save.");
                    } catch { setSaveError("Not saved. Your draft is retained; retry Save."); }
                    finally { setIsSaving(false); }
                  }}>Save</Button>
                  <Button variant="default" disabled={isSaving || busy} onClick={() => { setEditing(null); setDraft(""); setSaveError(null); }}>Cancel</Button>
                </Group>
              </Stack> : <Group align="flex-start" gap="sm" wrap="nowrap"><Text flex={1} size="sm" fw={action ? 500 : 400}>{value || "Not provided"}</Text><Button variant="subtle" color="dark" size="compact-sm" disabled={editing !== null || busy}
                aria-label={action ? controlLabel : `${controlLabel}: ${value ?? "Not provided"}`}
                onClick={() => { setEditing(key); setDraft(value ?? ""); setSaveError(null); }}>Edit</Button></Group>}
            </Stack>;
          })}
          {s.nextActionEditedAt && Number.isFinite(Date.parse(s.nextActionEditedAt)) && <Text size="xs" c="dimmed">Action saved {new Date(s.nextActionEditedAt).toLocaleString()}</Text>}
        </Stack>

        <Group gap="xs" wrap="wrap" hidden={section !== "context"}>
          <Text size="xs" c="dimmed" flex={1}>
            {activityLine(p)}
          </Text>
          <TechnicalActivityBadge detail={p.relevance.reasons.map((r) => r.detail).join(" · ")} />
        </Group>

        {section === "context" && s.evidence.length > 0 && (
          <>
            <Button
              variant="default"
              aria-expanded={showEvidence}
              size="xs"
              onClick={() => setShowEvidence((v) => !v)}
              style={{ display: "flex", alignItems: "center", gap: 4 }}
            >
              <IconChevronDown
                size={12}
                style={{ transform: showEvidence ? "rotate(180deg)" : undefined }}
              />
              {showEvidence ? "Hide evidence" : `Evidence (${s.evidence.length})`}
            </Button>
            <Collapse in={showEvidence}>
              <EvidenceList evidence={s.evidence} />
            </Collapse>
          </>
        )}
      </Stack>
    </Card>
  );
}
