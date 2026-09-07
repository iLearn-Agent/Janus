import { Pressable, SafeAreaView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { sessions } from '@/mock/data';
import { styles } from '@/theme';

export default function SessionsScreen() { return <SafeAreaView style={styles.safe}><View style={styles.container}><Text style={styles.title}>会话</Text><Pressable style={styles.primaryButton} onPress={() => router.push('/session/new')}><Text style={styles.primaryText}>新建 uBuddy 会话</Text></Pressable>{sessions.map((item) => <Pressable key={item.id} style={styles.card} onPress={() => router.push(`/session/${item.id}`)}><Text style={styles.cardTitle}>{item.title}</Text><Text style={styles.muted}>{item.preview}</Text></Pressable>)}</View></SafeAreaView>; }
