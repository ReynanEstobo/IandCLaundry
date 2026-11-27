import { quantity } from "../utils/alertText";
import { SUPPLY_CHOICES, changedSupplyCount, chosenReplacement, peso, supplyCharge } from "../utils/orderSupplies";

const BADGES = { default: "Shop's usual", substitute: "Other item", customer_own: "Customer's own", none: "Left out" };
const NOT_OFFERED = { substitute: "Other item", customer_own: "Customer's own", none: "Leave out" };

// The supply step of an order: the supplies each service usually uses, laid
// out like the add-ons step. Nothing needs to change for a normal order; staff
// change a supply only when the customer asks, within what the Administrator
// allows for that supply on the Services page.
export default function OrderSupplyChoices({ services, onChange, hasSelectedServices }) {
  const withSupplies = services.filter((service) => service.recipe.length > 0);
  if (!withSupplies.length) {
    return (
      <div className="addon-empty-state">
        {hasSelectedServices
          ? "The selected services have no usual supplies set."
          : "Select a service in Step 2 to see the supplies it uses."}
      </div>
    );
  }
  return (
    <div className="addon-service-groups">
      {withSupplies.map((service) => {
        const changes = changedSupplyCount(service.choices, service.recipe);
        const charge = supplyCharge(service.choices, service.recipe, service.loads);
        return (
          <section key={service.index} className="addon-service-group" aria-labelledby={`supply-service-${service.index}`}>
            <div className="addon-service-heading">
              <span className="addon-service-kicker">Service</span>
              <strong id={`supply-service-${service.index}`}>{service.label}</strong>
              <span className="addon-service-help">
                {service.weightEntered
                  ? `Amounts are for ${service.loads} load${service.loads === 1 ? "" : "s"}.`
                  : "Amounts are for one load until the weight is entered."}
              </span>
              {changes > 0 && (
                <span className="supply-change-chip">
                  {changes} change{changes === 1 ? "" : "s"}{charge > 0 ? ` · +${peso(charge)}` : " · no extra charge"}
                </span>
              )}
            </div>
            <div className="addon-grid">
              {service.recipe.map((line) => (
                <SupplyCard
                  key={line.requirementId}
                  line={line}
                  service={service}
                  onChange={(next) => onChange(service.index, next)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SupplyCard({ line, service, onChange }) {
  const current = service.choices?.[line.requirementId];
  const choice = current?.choice || "default";
  const needed = line.quantityPerLoad * service.loads;
  const options = line.replacements || [];
  const replacement = chosenReplacement(line, current);
  const idPrefix = `supply-${service.index}-${line.requirementId}`;
  const allowed = {
    default: true,
    substitute: options.length > 0,
    customer_own: line.allowCustomerOwn,
    none: line.allowLeaveOut,
  };
  const notOffered = Object.keys(NOT_OFFERED).filter((key) => !allowed[key]).map((key) => NOT_OFFERED[key]);

  function choose(value) {
    const next = { ...(service.choices || {}) };
    if (value === "default") delete next[line.requirementId];
    // With only one approved replacement, pick it straight away.
    else if (value === "substitute") next[line.requirementId] = { choice: value, replacementId: options.length === 1 ? options[0].replacementId : "" };
    else next[line.requirementId] = { choice: value };
    onChange(next);
  }

  let status = `${quantity(needed, line.item.unit)} for this service · ${quantity(line.item.current_stock, line.item.unit)} in stock`;
  if (choice === "customer_own") status = "The customer brings their own, so nothing is taken from stock. The price stays the same.";
  if (choice === "none") status = "Not used for this customer, so nothing is taken from stock. The price stays the same.";
  if (choice === "substitute") {
    status = replacement
      ? `${replacement.item.name} will be used instead · ${quantity(replacement.quantityPerLoad * service.loads, replacement.item.unit)} for this service`
      : "Choose the item to use instead.";
  }

  return (
    <div className={`addon-item supply-item ${choice !== "default" ? "selected" : ""}`}>
      <div className="addon-info">
        <span className="addon-name-row">
          <span className="addon-name">{line.item.name}</span>
          <span className={choice === "default" ? "supply-badge" : "addon-service-badge"}>{BADGES[choice]}</span>
        </span>
        <span className="addon-stock" id={`${idPrefix}-status`}>{status}</span>
      </div>
      <div className="supply-choice-toggle" role="group" aria-label={`What to use for ${line.item.name}`} aria-describedby={`${idPrefix}-status`}>
        {SUPPLY_CHOICES.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`supply-choice-btn ${choice === option.value ? "active" : ""}`}
            aria-pressed={choice === option.value}
            disabled={!allowed[option.value] && choice !== option.value}
            onClick={() => choose(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {choice === "substitute" && (
        <div className="supply-option-list" role="radiogroup" aria-label={`Item to use instead of ${line.item.name}`}>
          {options.map((option) => {
            const amount = option.quantityPerLoad * service.loads;
            const enough = Number(option.item.current_stock || 0) >= amount;
            const charge = option.extraChargePerLoad * service.loads;
            const selected = replacement?.replacementId === option.replacementId;
            return (
              <button
                key={option.replacementId}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!enough && !selected}
                className={`supply-option ${selected ? "selected" : ""}`}
                onClick={() => onChange({ ...(service.choices || {}), [line.requirementId]: { choice: "substitute", replacementId: option.replacementId } })}
              >
                <span className="supply-option-main">
                  <span className="supply-option-name">{option.item.name}</span>
                  <span className="supply-option-meta">
                    {quantity(amount, option.item.unit)} · {enough ? `${quantity(option.item.current_stock, option.item.unit)} in stock` : "not enough stock"}
                  </span>
                </span>
                <span className={`supply-option-charge ${charge > 0 ? "" : "is-free"}`}>{charge > 0 ? `+${peso(charge)}` : "No extra charge"}</span>
              </button>
            );
          })}
        </div>
      )}
      {notOffered.length > 0 && (
        <span className="form-hint supply-hint">Not offered for this supply: {notOffered.join(", ")}</span>
      )}
    </div>
  );
}
