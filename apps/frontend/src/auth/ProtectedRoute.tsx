import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

/** Everything below this route needs a signed-in user; anyone else is sent to sign in, then returned here. */
export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();
  if (status !== 'signedIn') {
    return <Navigate to="/signin" replace state={{ returnTo: `${location.pathname}${location.search}` }} />;
  }
  return <Outlet />;
}
