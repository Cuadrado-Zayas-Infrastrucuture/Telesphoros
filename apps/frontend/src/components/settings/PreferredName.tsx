import { useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';

export function PreferredName() {
  const { preferredName, setPreferredName } = useAuth();
  const [draft, setDraft] = useState(preferredName ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <form
      className="mt-4 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setPreferredName(draft);
        setSaved(true);
      }}
    >
      <label htmlFor="preferred-name">Preferred name</label>
      <Input
        id="preferred-name"
        value={draft}
        maxLength={80}
        autoComplete="off"
        aria-describedby="preferred-name-help"
        onChange={(event) => {
          setDraft(event.target.value);
          setSaved(false);
        }}
      />
      <p id="preferred-name-help" className="text-sm text-muted-foreground">
        Optional. Personalizes your chat welcome for this sign-in. Kept in this tab’s memory; cleared when you sign out or reload. Leave blank to remove it.
      </p>
      <div>
        <Button type="submit" variant="outline">
          Save preferred name
        </Button>
      </div>
      {saved && (
        <p role="status" className="text-sm text-muted-foreground">
          Preferred name saved for this sign-in.
        </p>
      )}
    </form>
  );
}
