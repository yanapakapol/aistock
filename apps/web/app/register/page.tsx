import { RegisterForm } from './register-form';

export const dynamic = 'force-dynamic';

export default function RegisterPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <RegisterForm />
    </div>
  );
}
