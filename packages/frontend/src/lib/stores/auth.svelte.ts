let authenticated = $state(false);
let checking = $state(true);
let authRequired = $state(true);

export async function checkAuth(): Promise<boolean> {
  checking = true;

  try {
    const response = await fetch('/api/auth/check', {
      credentials: 'include'
    });

    if (response.ok) {
      const data = await response.json();
      authenticated = data.authenticated === true;
      if (data.auth_required === false) authRequired = false;
    } else {
      authenticated = false;
    }
    return authenticated;
  } catch (err) {
    console.error('Auth check failed:', err);
    authenticated = false;
    return false;
  } finally {
    checking = false;
  }
}

export async function login(password: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password })
    });

    if (response.ok) {
      authenticated = true;
      return { success: true };
    } else {
      const data = await response.json();
      return { success: false, error: data.error || 'Login failed' };
    }
  } catch (err) {
    console.error('Login error:', err);
    return { success: false, error: 'Network error' };
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include'
    });
  } catch (err) {
    console.error('Logout error:', err);
  } finally {
    authenticated = false;
  }
}

export function isAuthenticated() {
  return authenticated;
}

export function isChecking() {
  return checking;
}

export function isAuthRequired() {
  return authRequired;
}
