import { redirect } from 'next/navigation';

/** There is no public landing page: the shell is the product, and middleware decides where you go. */
export default function Home() {
  redirect('/registry');
}
