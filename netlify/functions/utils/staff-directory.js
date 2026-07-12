// Maps an IPG staff member's name (as it comes through on Bindly's client
// record for Producer / CSR) to their phone + email, so the portal can show
// a full contact card even if Bindly's own field only carries a name.
// Key on the lowercased, trimmed name exactly as Bindly sends it — add an
// extra key for any nickname/spelling variant Bindly might use.
//
// Example:
// "cole leclair": { phone: "(214) 377-1460", email: "cole@ipg.team" },

module.exports = {
};
