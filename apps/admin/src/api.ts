export type ApiUser = {
  id: string;
  role: "ADMIN" | "HOMEMAKER";
  name: string;
  phone: string;
  mustChangePassword: boolean;
};

let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

async function refresh(): Promise<boolean> {
  const response = await fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) return false;
  const body = (await response.json()) as { accessToken: string };
  accessToken = body.accessToken;
  return true;
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}, allowRefresh = true): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (response.status === 401 && allowRefresh && (await refresh())) {
    return api<T>(path, options, false);
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data?.error?.message ?? "The request failed.";
    const error = new Error(message) as Error & { code?: string };
    error.code = data?.error?.code;
    throw error;
  }
  return data as T;
}

export async function download(path: string, filename: string) {
  const response = await fetch(path, {
    credentials: "include",
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
  if (!response.ok) throw new Error("The export failed.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
