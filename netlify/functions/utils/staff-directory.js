// Maps an IPG staff member's name (as it comes through on Bindly's client
// record for Producer / CSR) to their phone + email, so the portal can show
// a full contact card even if Bindly's own field only carries a name.
// Key on the lowercased, trimmed name exactly as Bindly sends it — add an
// extra key for any nickname/spelling variant Bindly might use.

module.exports = {
  "cole leclair": { phone: "214-404-9776", email: "cole@ipg.team" },
  "hunter leclair": { phone: "972-322-3933", email: "hunter@ipg.team" },
  "julie nguyen": { phone: "469-679-1951", email: "julie@ipg.team" },
  "ashton warman": { phone: "214-308-0985", email: "ashton@ipg.team" }
};
