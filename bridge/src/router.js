// Bảng route của bridge: mảng khai báo theo THỨ TỰ, khớp cái đầu trùng thì
// thắng. `match` nhận ba dạng:
//   "/api/state"            — khớp tuyệt đối
//   /^\/api\/devices\/[^/]+$/ — RegExp
//   "*/api/ow/"             — tiền tố (dùng cho proxy)
// method "*" = mọi HTTP method (proxy xuyên qua, không lọc verb).
// `public: true` = không cần token (ghép thiết bị); mọi route còn lại nằm sau
// cổng khóa của auth.js.

export function matchRoute(routes, req, pathname) {
  for (const route of routes) {
    if (route.method !== "*" && route.method !== req.method) continue;
    const match = route.match;
    if (typeof match === "string") {
      if (match.startsWith("*")) {
        if (!pathname.startsWith(match.slice(1))) continue;
      } else if (match !== pathname) {
        continue;
      }
    } else if (!match.test(pathname)) {
      continue;
    }
    return route;
  }
  return null;
}