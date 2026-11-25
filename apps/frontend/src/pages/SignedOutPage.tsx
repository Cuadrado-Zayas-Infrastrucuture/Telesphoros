import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';
import { SIGNED_OUT_WORDS } from '@/lib/words/signIn';
import { useWords } from '@/lib/words/screens';

export default function SignedOutPage() {
  const words = useWords(SIGNED_OUT_WORDS);
  usePageTitle(words.title);
  return (
    <div className="flex max-w-prose flex-col gap-4">
      <h1 className="font-sans text-4xl leading-tight font-medium tracking-tight">{words.heading}</h1>
      <p className="text-muted-foreground">{words.body}</p>
      <div>
        <Button asChild>
          <Link to="/signin">{words.signIn}</Link>
        </Button>
      </div>
    </div>
  );
}
