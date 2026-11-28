/**
 * Who is signed in, and the two things they can do about it.
 *
 * A disclosure rather than two buttons parked at the foot of the sidebar: the
 * name and role are worth seeing all the time, and "Sign out" is not worth a
 * permanent place on every screen.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

const ROLE_LABELS = { admin: 'Admin', staff: 'Staff' };

export default function UserMenu({ user, onSignOut }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onPointer(event) {
      if (!root.current?.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = user.fullName || user.username;

  return (
    <div className="user-menu" ref={root}>
      <button
        type="button"
        className="user-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Avatar name={name} size={32} />
        <span className="user-menu-name">
          <span>{name}</span>
          <span className="user-menu-role">
            {ROLE_LABELS[user.role] ?? user.role} · {user.clubName}
          </span>
        </span>
        <Icon name="chevronDown" size={15} />
      </button>

      {open && (
        <div className="menu" role="menu">
          <Link to="/account/password" role="menuitem" className="menu-item" onClick={() => setOpen(false)}>
            <Icon name="key" size={16} />
            Change password
          </Link>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
          >
            <Icon name="signOut" size={16} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
