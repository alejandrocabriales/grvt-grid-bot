import { NextRequest, NextResponse } from "next/server";

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const COOKIE_NAME = "bot_auth";

export function middleware(req: NextRequest) {
  // Si no hay password configurado, acceso libre
  if (!DASHBOARD_PASSWORD) return NextResponse.next();

  const { pathname } = req.nextUrl;

  // Las API routes y la página de login no se protegen
  if (pathname.startsWith("/api/") || pathname === "/login") {
    return NextResponse.next();
  }

  const authCookie = req.cookies.get(COOKIE_NAME);
  if (authCookie?.value === DASHBOARD_PASSWORD) {
    return NextResponse.next();
  }

  // Redirigir al login
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
