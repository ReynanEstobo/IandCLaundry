import { LogOut } from 'lucide-react'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext'
import ConfirmDialog from './ConfirmDialog'

// Asks before signing out, so a stray click on a shared shop computer does not
// end the session in the middle of work.
export default function SignOutConfirm({ open, onClose }) {
  const { signOut } = useAuth()
  const [signingOut, setSigningOut] = useState(false)

  async function confirm() {
    setSigningOut(true)
    try {
      await signOut()
    } catch (error) {
      setSigningOut(false)
      toast.error(error?.message || 'Unable to sign out. Please try again.')
      return
    }
    setSigningOut(false)
    onClose()
    toast.success('You have been signed out.')
  }

  return (
    <ConfirmDialog
      open={open}
      title="Sign out?"
      message="You will need your username and password to sign in again. Anything you have not saved on this screen will be lost."
      confirmLabel="Sign out"
      cancelLabel="Stay signed in"
      variant="primary"
      icon={<LogOut size={22} />}
      loading={signingOut}
      onConfirm={confirm}
      onClose={onClose}
    />
  )
}
