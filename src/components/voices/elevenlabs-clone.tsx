import * as React from "react";
import { Check, CloudUpload, Loader2, Lock, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  elevenlabsCreateClone,
  elevenlabsDeleteVoice,
} from "@/lib/engines/elevenlabs";
import { platformFetch } from "@/lib/engines/http";
import type { Person } from "@/lib/schemas/people";
import { readFileBytes } from "@/lib/storage";
import { personDir, usePeopleStore } from "@/stores/people-store";
import { useSettingsStore } from "@/stores/settings-store";

// ElevenLabs instant voice clone (spec §2.4, M5 item 3). Hard rules: the
// upload is preceded by an explicit consent step stating the reference audio
// leaves the device, and the whole surface is blocked in privacy mode — both
// here at the call site and via the router's API-engine filter. Deleting the
// clone removes the voice from the ElevenLabs account, not just the profile.

export function ElevenLabsClone({ person }: { person: Person }) {
  const update = usePeopleStore((s) => s.update);
  const privacyMode = useSettingsStore((s) => s.privacyMode);
  const apiKey = useSettingsStore((s) => s.apiKeys.elevenlabs ?? "");

  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const cloneId = person.clones.elevenlabs?.voiceId ?? null;

  async function createClone() {
    // Call-site guard (spec §2.4): never reachable in privacy mode even if
    // the button somehow rendered.
    if (privacyMode || !person.cloneRef) return;
    setBusy(true);
    setError(null);
    try {
      const refPath = `${personDir(person.id)}/${person.cloneRef.samples[0].path}`;
      const bytes = await readFileBytes(refPath);
      if (bytes.length === 0) throw new Error("clone reference audio not found");
      const voiceId = await elevenlabsCreateClone({
        fetch: platformFetch(),
        apiKey,
        name: `${person.name} (Vocalis clone)`,
        bytes,
        filename: "reference.wav",
      });
      await update(person.id, {
        clones: { ...person.clones, elevenlabs: { voiceId } },
      });
      setConfirming(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteClone() {
    if (!cloneId) return;
    setBusy(true);
    setError(null);
    try {
      await elevenlabsDeleteVoice({
        fetch: platformFetch(),
        apiKey,
        voiceId: cloneId,
      });
      const { elevenlabs: _removed, ...rest } = person.clones;
      await update(person.id, { clones: rest });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  if (privacyMode) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <Lock className="h-4 w-4" /> ElevenLabs cloning is unavailable in
        privacy mode — the reference audio would leave the device.
      </p>
    );
  }

  if (cloneId) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-600 text-xs dark:text-emerald-400">
            <Check className="h-3.5 w-3.5" /> ElevenLabs clone ready
          </span>
          <code className="text-muted-foreground text-xs">{cloneId}</code>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            disabled={busy}
            onClick={() => void deleteClone()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="mr-1 h-4 w-4" />
            )}
            Delete clone
          </Button>
        </div>
        {error && <p className="text-destructive text-xs">{error}</p>}
      </div>
    );
  }

  if (!person.cloneRef) {
    return (
      <p className="text-muted-foreground text-sm">
        Record a clone reference above first — the same recording is used for
        the ElevenLabs clone.
      </p>
    );
  }

  if (!apiKey) {
    return (
      <p className="text-muted-foreground text-sm">
        Add an ElevenLabs API key in Settings → API Keys to create a cloud
        clone (useful for French — the local engine is English-only).
      </p>
    );
  }

  if (!confirming) {
    return (
      <div className="flex flex-col gap-2">
        <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
          <CloudUpload className="mr-1 h-4 w-4" /> Create ElevenLabs clone
        </Button>
        {error && <p className="text-destructive text-xs">{error}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="text-sm">
        The clone reference recording of{" "}
        <span className="font-medium">{person.name}</span> will be{" "}
        <span className="font-medium">
          uploaded to ElevenLabs and leave this device
        </span>
        . It is stored in your ElevenLabs account until the clone is deleted.
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void createClone()}>
          {busy ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <CloudUpload className="mr-1 h-4 w-4" />
          )}
          Upload and create clone
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  );
}
