import { useEffect, useState } from "react";
import { api, type CardInfo, type Status } from "../api";
import { ErrNote, Seal, Spinner, shortAddr } from "../ui";
import { VCard, CardHistory } from "../vcard";

/// C5: read-only verify view — #/verify/<address-or-uid>. Resolves everything
/// live: Dojang verification, active up.id, current card, version history.
/// Shareable; needs no passkey, no session.
export function Verify({ id }: { id: string }) {
  const [card, setCard] = useState<CardInfo | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    (async () => {
      try {
        const c = await api.card(id);
        setCard(c);
        if (c.address) setStatus(await api.status(c.address));
        else if (/^0x[0-9a-fA-F]{40}$/.test(id)) setStatus(await api.status(id));
        else setError("Unknown address or attestation uid.");
      } catch (e) {
        setError(e);
      }
    })();
  }, [id]);

  if (error != null) return <ErrNote error={error} />;
  if (!card || (!status && card.address)) {
    return (
      <div className="status-line">
        <Spinner /> resolving on GIWA Sepolia…
      </div>
    );
  }

  return (
    <div>
      <div className="card">
        <h2>Suho verification</h2>
        {status && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {status.isVerified ? <Seal /> : <span style={{ fontSize: "1.3rem" }}>⚠️</span>}
            <div>
              <div className="name" style={{ fontWeight: 600 }}>
                {status.upId ? `${status.upId}.up.id` : shortAddr(status.address)}
              </div>
              <div className="muted mono">{status.address}</div>
              {status.isVerified ? (
                <div>
                  <div className="verified-label">Verified human</div>
                  <div className="attestation-note" title={`Attester: ${status.verifiedBy}`}>
                    Dojang attestation · testnet issuer
                  </div>
                </div>
              ) : (
                <div className="warnbox">Not Dojang-verified.</div>
              )}
            </div>
          </div>
        )}
      </div>

      <hr className="hairline" />

      {card.current && status ? (
        <>
          <VCard
            card={card.current}
            address={status.address}
            upId={status.upId}
            verified={status.isVerified}
          />
          <CardHistory history={card.history} />
        </>
      ) : (
        <div className="card center muted">No Suho Card attested for this address.</div>
      )}
    </div>
  );
}
