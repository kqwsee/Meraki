import { Link } from "react-router-dom";

export default function Brand() {
  return (
    <Link to="/" className="brand" aria-label="Meraki — главная">
      <img src="/favicon.svg" alt="" width="32" height="32" />
      Meraki
    </Link>
  );
}
