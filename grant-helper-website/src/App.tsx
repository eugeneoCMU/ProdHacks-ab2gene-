import { useEffect, useState } from 'react'
import Layout from './components/layout/Layout'
import ProfileView from './components/pages/ProfileView'
import SearchView from './components/pages/SearchView'
import WorkspaceView from './components/pages/WorkspaceView'
import './App.css'

const PROFILE_STORAGE_KEY = 'grantflow.organizationProfile'
const PROFILE_SUMMARY_STORAGE_KEY = 'grantflow.profileSummary'

function buildProfileSummary(profile: string) {
  const trimmed = profile.trim()
  const preview = trimmed.slice(0, 320)
  const sentenceCount = trimmed ? trimmed.split(/[.!?]+/).filter(Boolean).length : 0

  return {
    preview,
    characters: trimmed.length,
    sentences: sentenceCount,
    updatedAt: new Date().toISOString(),
  }
}

function App() {
  const [activeView, setActiveView] = useState('profile')
  const [organizationProfile, setOrganizationProfile] = useState(() => {
    if (typeof window === 'undefined') return ''
    return window.localStorage.getItem(PROFILE_STORAGE_KEY) || ''
  })

  useEffect(() => {
    if (typeof window === 'undefined') return

    window.localStorage.setItem(PROFILE_STORAGE_KEY, organizationProfile)
    window.localStorage.setItem(
      PROFILE_SUMMARY_STORAGE_KEY,
      JSON.stringify(buildProfileSummary(organizationProfile))
    )
  }, [organizationProfile])

  const renderView = () => {
    switch (activeView) {
      case 'profile':
        return (
          <ProfileView
            organizationProfile={organizationProfile}
            onOrganizationProfileChange={setOrganizationProfile}
          />
        )
      case 'search':
        return <SearchView organizationProfile={organizationProfile} />
      case 'workspace':
        return <WorkspaceView organizationProfile={organizationProfile} />
      default:
        return (
          <ProfileView
            organizationProfile={organizationProfile}
            onOrganizationProfileChange={setOrganizationProfile}
          />
        )
    }
  }

  return (
    <Layout activeView={activeView} onNavigate={setActiveView}>
      {renderView()}
    </Layout>
  )
}

export default App
