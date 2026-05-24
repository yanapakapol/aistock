import { RegisterForm } from './register-form';
import { GuestForm } from './guest-form';

export const dynamic = 'force-dynamic';

interface RegisterPageProps {
  // Next.js 15 passes searchParams as a Promise to async page components.
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function RegisterPage({ searchParams }: RegisterPageProps) {
  const sp = (await searchParams) ?? {};
  const guestParam = sp.guest;
  const isGuest = guestParam === '1' || guestParam === 'true';
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      {isGuest ? <GuestForm /> : <RegisterForm />}
    </div>
  );
}
