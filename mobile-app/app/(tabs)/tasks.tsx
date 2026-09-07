import { SafeAreaView, Text, View } from 'react-native';
import { tasks } from '@/mock/data';
import { styles } from '@/theme';

export default function TasksScreen() { return <SafeAreaView style={styles.safe}><View style={styles.container}><Text style={styles.title}>任务</Text>{tasks.map((item) => <View key={item.id} style={styles.card}><Text style={styles.cardTitle}>{item.title}</Text><Text style={styles.muted}>{item.status}</Text></View>)}</View></SafeAreaView>; }
