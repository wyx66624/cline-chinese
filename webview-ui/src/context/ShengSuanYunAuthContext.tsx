import React, { createContext, useContext, useEffect, useState } from "react"
import { AccountServiceClient } from "@/services/grpc-client"
import { EmptyRequest } from "@shared/proto/cline/common"

interface ShengSuanYunAuthContextType {
	user: any | null
}

const ShengSuanYunAuthContext = createContext<ShengSuanYunAuthContextType | undefined>(undefined)

export const ShengSuanYunAuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
	const [user, setUser] = useState<any | null>(null)

	useEffect(() => {
		const cancelSubscription = AccountServiceClient.subscribeToAuthStatusUpdate(EmptyRequest.create(), {
			onResponse: async (response: any) => {
				if (!response?.user) {
					setUser(null)
				} else {
					setUser(response.user)
				}
			},
			onError: (error: Error) => {
				console.error("Error in auth callback subscription:", error)
			},
			onComplete: () => {
				console.log("Auth callback subscription completed")
			},
		})
		return () => {
			cancelSubscription()
		}
	}, [])

	return <ShengSuanYunAuthContext.Provider value={{ user }}>{children}</ShengSuanYunAuthContext.Provider>
}

export const handleSignInSSY = async () => {
	try {
		AccountServiceClient.shengSuanYunLoginClicked(EmptyRequest.create()).catch((err) =>
			console.error("Failed to get login URL:", err),
		)
	} catch (error) {
		console.error("Error signing in:", error)
		throw error
	}
}

export const handleSignOutSSY = async () => {
	try {
		await AccountServiceClient.shengSuanYunLogoutClicked(EmptyRequest.create()).catch((err) =>
			console.error("Failed to logout:", err),
		)
	} catch (error) {
		console.error("Error signing out:", error)
		throw error
	}
}

export const useShengSuanYunAuth = () => {
	const context = useContext(ShengSuanYunAuthContext)
	if (context === undefined) {
		throw new Error("useShengSuanYunAuth must be used within a ShengSuanYunAuthProvider")
	}
	return context
}
