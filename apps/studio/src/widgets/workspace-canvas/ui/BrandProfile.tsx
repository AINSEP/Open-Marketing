import type { ReactElement } from 'react';
import { ApprovalCard } from '../../../features/approve/index.js';
import { useBrandProfile } from './BrandProfile.hooks.js';
import type { BrandProfileProps, BrandOfferProps, BrandFieldProps } from './BrandProfile.hooks.js';

/** Creative's compact brand editor; sample workspaces never mount the live hook.
 * @example <BrandProfile api={api} runtime={runtime} sample={false} onOpenChat={openChat} />
 */
export function BrandProfile(props: BrandProfileProps): ReactElement {
  return props.sample ? <section aria-label="Brand profile"><h2>Brand profile</h2><p>Connect to your workspace server to edit the brand profile</p></section> : <BrandProfileEditor {...props} />;
}

/** Native fields and server cards; effects and event binding stay in the hook. */
function BrandProfileEditor(props: BrandProfileProps): ReactElement {
  const brand = useBrandProfile(props);
  return <section className="canvas-card" aria-label="Brand profile">
    <div className="canvas-card-body">
      <div className="section-heading"><h2>Brand profile</h2><button type="button" onClick={brand.refresh} disabled={brand.busy}>Refresh</button></div>
      <section aria-label="Latest brand revision"><h3>Latest revision</h3><p>{brand.latest ? 'Revision ' + brand.latest.revision + ' · ' + brand.latest.status + ' · ' + new Date(brand.latest.at).toLocaleString() : 'No revision loaded'}</p></section>
      <section aria-label="Confirmed brand revision"><h3>Confirmed revision</h3><p>{brand.confirmed ? 'Revision ' + brand.confirmed.revision + ' · ' + brand.confirmed.kit.business.name : 'No confirmed profile'}</p>
        {brand.confirmed && <details><summary>Confirmed facts and guidance</summary><pre>{JSON.stringify(brand.confirmed.kit, null, 2)}</pre></details>}
      </section>
      <form onSubmit={brand.save}>
        <fieldset disabled={brand.disabled}>
          <legend>Business facts and copy guidance</legend>
          <p className="muted">Enter one fact or rule per line. The assistant uses the confirmed revision.</p>
          <label>Business name<input required {...brand.businessName} /></label>
          {brand.fields.map(renderField)}
          <fieldset><legend>Offers / products and services</legend>
            {brand.offers.map(renderOffer)}
            <button type="button" onClick={brand.addOffer} disabled={brand.offers.length >= 20}>Add offer</button>
          </fieldset>
          <button type="submit">Save draft</button>
          {brand.latest?.status === 'draft' && <button type="button" onClick={brand.confirm}>Confirm revision {brand.latest.revision}</button>}
        </fieldset>
      </form>
      <details><summary>Colours, fonts and asset references (read-only)</summary><pre>{brand.visualDetails}</pre></details>
      {brand.card && <ApprovalCard key={brand.card.cardId} card={brand.card} api={props.api} runtime={props.runtime} sample={false} />}
      {brand.error && <p role="alert">{brand.error}</p>}
      <p role="status">{brand.notice}</p>
      <p>Ask the assistant to draft copy variants from the confirmed profile.</p>
      <button type="button" onClick={props.onOpenChat}>Ask the assistant</button>
    </div>
  </section>;
}

/** Native textarea callback renders hook-bound values without introducing component closures. */
function renderField(field: BrandFieldProps): ReactElement {
  return <label key={field.field}>{field.label}<textarea rows={3} value={field.value} onChange={field.onChange} /></label>;
}
/** Controlled offer rows keep names and newline-separated facts together. */
function renderOffer(offer: BrandOfferProps): ReactElement {
  return <fieldset key={offer.index}><legend>Offer {offer.index + 1}</legend>
    <label>Offer name<input required value={offer.name} onChange={offer.onNameChange} /></label>
    <label>Offer facts<textarea rows={3} value={offer.facts} onChange={offer.onFactsChange} /></label>
    <button type="button" onClick={offer.remove}>Remove offer {offer.index + 1}</button>
  </fieldset>;
}
