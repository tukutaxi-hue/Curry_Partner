import { SignJWT, jwtVerify } from "jose";
import { config } from "../config.js";

export type AccessClaims = {
  sub: string;
  role: "ADMIN" | "HOMEMAKER";
  sid: string;
  tv: number;
};

const key = () => new TextEncoder().encode(config.accessTokenSecret);

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ role: claims.role, sid: claims.sid, tv: claims.tv })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(key());
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
  const role = payload.role;
  const sid = payload.sid;
  const tv = payload.tv;
  if ((role !== "ADMIN" && role !== "HOMEMAKER") || typeof sid !== "string" || typeof tv !== "number" || !payload.sub) {
    throw new Error("Invalid access token");
  }
  return { sub: payload.sub, role, sid, tv };
}
